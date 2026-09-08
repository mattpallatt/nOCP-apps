// Action router — ported from the source app's
// src/backend/functions/CmsUiExtension.ts. Same {action, params} in /
// {ok, result} | {ok:false, error, message?} out envelope; the transport
// changed (OCP's App.Function/invokeFunction RPC → a plain
// POST /content-transfer/api route in lambda.ts) and jobs.trigger/
// storage.kvStore progress reads became preCheckRunner.ts's/
// transferRunner.ts's startPreCheck+getPreCheckProgress/
// startTransfer+getTransferProgress. All 11 action names are unchanged —
// no reason to rename them, the frontend calls them by name.
import {logger} from './logger';
import {CmapiCredentials, CmsError, getContentDisplayName, listChildren, listVersions} from './cma';
import {CONTAINER_CHILDREN_PAGE_SIZE} from './constants';
import {
  buildEnvironmentProfiles,
  environmentDisplayName,
  extractSourceHostname,
  findEnvironmentForHostname,
  normalizeContentKey,
  EnvironmentProfile,
} from './environments';
import {applyManifestDiff, diffManifests, getManifest, ManifestSection} from './manifest';
import {resolveAncestorTargetParent, PreCheckItem} from './preCheck';
import {TransferOptions} from './transferEngine';
import {getPreCheckProgress, startPreCheck} from './preCheckRunner';
import {getTransferProgress, startTransfer} from './transferRunner';
import {getSettings} from './settingsStore';

const CMS_STATUS: Record<CmsError['code'], number> = {
  unauthorized: 502,
  not_found: 404,
  request_failed: 502,
  conflict: 409,
};

export type Envelope<T> =
  | {ok: true; result: T}
  | {ok: false; error: string; message?: string};

function ok<T>(result: T): Envelope<T> {
  return {ok: true, result};
}

function fail(error: string, message?: string): Envelope<never> {
  return message ? {ok: false, error, message} : {ok: false, error};
}

interface ResolvedEnvironments {
  source: EnvironmentProfile;
  all: EnvironmentProfile[];
}

type ResolveEnvironmentsFailure =
  // No environments saved in Settings at all.
  | {reason: 'not_configured'}
  // _diag.href was missing/unparseable — can happen in a preview/builder
  // surface that isn't the actual embedded CMS admin sidebar, which is the
  // only place `_diag.href` reflects a real CMS hostname.
  | {reason: 'hostname_unresolvable'}
  // Environments are configured, but none of their Match Pattern values are
  // a substring of this hostname — almost always a typo/mismatch in
  // Settings, not a "not set up" situation.
  | {reason: 'hostname_not_matched'; hostname: string; configuredPatterns: string[]};

/**
 * Identifies which configured environment the calling sidebar iframe is
 * running on, by hostname — same `_diag.href` diagnostic convention as the
 * source app. Returns a specific failure reason rather than a bare null:
 * the three causes below look identical to a user (nothing loads) but need
 * different fixes.
 */
async function resolveEnvironments(
  params: Record<string, unknown>,
): Promise<{ok: true; value: ResolvedEnvironments} | {ok: false; failure: ResolveEnvironmentsFailure}> {
  const settings = await getSettings();
  const all = buildEnvironmentProfiles(settings);
  if (all.length === 0) return {ok: false, failure: {reason: 'not_configured'}};

  const diag = (params._diag ?? {}) as {href?: unknown; ancestorOrigins?: unknown; referrer?: unknown};
  const hostname = extractSourceHostname(diag);
  if (!hostname) {
    logger.warn(`[ContentTransfer] Could not extract a hostname from _diag.href=${JSON.stringify(diag.href)} — cannot resolve an environment`);
    return {ok: false, failure: {reason: 'hostname_unresolvable'}};
  }

  const matches = findEnvironmentForHostname(all, hostname);
  if (matches.length === 0) {
    logger.warn(`[ContentTransfer] No configured environment's matchPattern matched hostname "${hostname}"`);
    return {
      ok: false,
      failure: {reason: 'hostname_not_matched', hostname, configuredPatterns: all.map((env) => env.matchPattern)},
    };
  }
  if (matches.length > 1) {
    logger.warn(
      `[ContentTransfer] Hostname "${hostname}" matched more than one configured environment ` +
      `(${matches.map((m) => m.matchPattern).join(', ')}) — using the first. Narrow the Match Pattern values to fix this.`,
    );
  }
  return {ok: true, value: {source: matches[0], all}};
}

function describeResolveFailure(failure: ResolveEnvironmentsFailure): Envelope<never> {
  switch (failure.reason) {
    case 'not_configured':
      return fail('not_configured', 'This app hasn’t been set up yet — open the app’s Settings and enter your CMAPI credentials for at least one environment.');
    case 'hostname_unresolvable':
      return fail(
        'hostname_unresolvable',
        'Could not determine which CMS environment this sidebar is running on. If this is a preview/builder surface rather than the live CMS admin, open the app inside the actual CMS SaaS admin sidebar instead.',
      );
    case 'hostname_not_matched':
      return fail(
        'hostname_not_matched',
        `This sidebar is running on "${failure.hostname}", which doesn’t match any configured Match Pattern ` +
        `(${failure.configuredPatterns.join(', ') || 'none'}). Open Settings and make sure one environment's ` +
        `Match Pattern is a substring of "${failure.hostname}".`,
      );
  }
}

function toCredentials(profile: EnvironmentProfile): CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string} {
  return {
    clientId: profile.clientId,
    clientSecret: profile.clientSecret,
    rootContainer: profile.rootContainer,
    contentGraphKey: profile.contentGraphKey,
    contentGraphSecret: profile.contentGraphSecret,
  };
}

function findTarget(all: EnvironmentProfile[], matchPattern: unknown): EnvironmentProfile | null {
  if (typeof matchPattern !== 'string' || !matchPattern) return null;
  return all.find((env) => env.matchPattern === matchPattern) ?? null;
}

function handleListEnvironments({source, all}: ResolvedEnvironments): Envelope<unknown> {
  return ok({
    source: {matchPattern: source.matchPattern, name: environmentDisplayName(source)},
    targets: all
      .filter((env) => env.matchPattern !== source.matchPattern)
      .map((env) => ({matchPattern: env.matchPattern, name: environmentDisplayName(env)})),
  });
}

async function handleGetContentName(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const rootKeyRaw = typeof params.rootKey === 'string' ? params.rootKey.trim() : '';
  if (!rootKeyRaw) return fail('missing_root_key');
  const rootKey = normalizeContentKey(rootKeyRaw);

  const name = await getContentDisplayName(toCredentials(resolved.source), rootKey);
  if (name === null) return fail('not_found');
  return ok({name});
}

/** Where preCheck would place this item on target if the editor never touches the destination tree — same resolveAncestorTargetParent logic preCheck itself uses, run standalone so the sidebar can preview it before a plan is checked. */
async function handleResolveDefaultParent(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const rootKeyRaw = typeof params.rootKey === 'string' ? params.rootKey.trim() : '';
  if (!rootKeyRaw) return fail('missing_root_key');
  const rootKey = normalizeContentKey(rootKeyRaw);

  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');

  const resolution = await resolveAncestorTargetParent(toCredentials(resolved.source), toCredentials(target), rootKey);
  if (resolution.unresolvable || !resolution.targetParentKey) {
    return ok({targetParentKey: null, name: null, isRootFallback: false, expandPath: []});
  }
  const name = await getContentDisplayName(toCredentials(target), resolution.targetParentKey);
  return ok({
    targetParentKey: resolution.targetParentKey,
    name: name ?? resolution.targetParentKey,
    isRootFallback: resolution.isRootFallback,
    expandPath: resolution.expandPath,
  });
}

/** The environment's configured Root Container Key itself, as the destination tree's top node — an editor can select it directly to move content to the root, not just to something under it. */
async function handleGetDestinationRoot(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');
  if (!target.rootContainer) {
    return fail(
      'no_root_configured',
      'This environment has no Root Container Key configured in Settings, so its content tree can’t be browsed yet.',
    );
  }
  const name = await getContentDisplayName(toCredentials(target), target.rootContainer);
  return ok({key: target.rootContainer, name: name ?? target.rootContainer});
}

/** Immediate children of a target-environment container, for the sidebar's destination-tree browser — defaults to that environment's configured Root Container Key when no containerKey is given, since that's the only "top of the tree" this app has any notion of. */
async function handleListContainerChildren(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');

  const containerKeyRaw = typeof params.containerKey === 'string' ? params.containerKey.trim() : '';
  const containerKey = containerKeyRaw ? normalizeContentKey(containerKeyRaw) : target.rootContainer;
  if (!containerKey) {
    return fail(
      'no_root_configured',
      'This environment has no Root Container Key configured in Settings, so its content tree can’t be browsed yet.',
    );
  }

  const {items} = await listChildren(toCredentials(target), containerKey, 0, CONTAINER_CHILDREN_PAGE_SIZE);
  // The /items listing's own `displayName` is unreliable (confirmed live:
  // consistently absent) — the real name lives on each item's latest
  // version, same as everywhere else this app resolves a display name (see
  // getContentDisplayName). Fetched in parallel since these are independent
  // reads and a container can have dozens of children.
  const names = await Promise.all(items.map(async (item) => {
    const [latestVersion] = await listVersions(toCredentials(target), item.key, 1);
    return latestVersion?.displayName ?? item.displayName ?? item.key;
  }));
  return ok({
    containerKey,
    items: items.map((item, i) => ({key: item.key, name: names[i]})),
  });
}

async function handleStartPreCheck(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const rootKeyRaw = typeof params.rootKey === 'string' ? params.rootKey.trim() : '';
  if (!rootKeyRaw) return fail('missing_root_key');
  // Accepts a content key pasted in either the hyphenated GUID form (as
  // shown in the CMS admin UI) or the bare 32-hex-char form this app itself
  // uses — see normalizeContentKey.
  const rootKey = normalizeContentKey(rootKeyRaw);

  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');

  const destinationParentKeyRaw = typeof params.destinationParentKey === 'string' ? params.destinationParentKey.trim() : '';
  const destinationParentKey = destinationParentKeyRaw ? normalizeContentKey(destinationParentKeyRaw) : undefined;

  const {jobId} = await startPreCheck({
    sourceMatchPattern: resolved.source.matchPattern,
    targetMatchPattern: target.matchPattern,
    rootKey,
    includeChildren: params.includeChildren === true,
    overwriteMatchingKeys: params.overwriteMatchingKeys === true,
    destinationParentKey,
  });

  return ok({jobId});
}

async function handleGetPreCheckProgress(params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const jobId = typeof params.jobId === 'string' ? params.jobId : '';
  if (!jobId) return fail('missing_job_id');
  return ok(await getPreCheckProgress(jobId));
}

async function handleStartTransfer(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');

  const items = Array.isArray(params.items) ? (params.items as unknown as PreCheckItem[]) : [];
  if (items.length === 0) return fail('missing_items');

  const rawOptions = (params.options ?? {}) as Record<string, unknown>;
  const options: TransferOptions = {
    status: rawOptions.status === 'CheckedOut' ? 'CheckedOut' : 'Published',
    selectedLocales: Array.isArray(rawOptions.selectedLocales)
      ? rawOptions.selectedLocales.filter((l): l is string => typeof l === 'string')
      : undefined,
  };

  const {jobId} = await startTransfer({
    sourceMatchPattern: resolved.source.matchPattern,
    targetMatchPattern: target.matchPattern,
    items,
    options,
  });

  return ok({jobId});
}

async function handleGetTransferProgress(params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const jobId = typeof params.jobId === 'string' ? params.jobId : '';
  if (!jobId) return fail('missing_job_id');
  return ok(await getTransferProgress(jobId));
}

async function handleManifestDiff(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');

  const sections = Array.isArray(params.sections)
    ? (params.sections as unknown as ManifestSection[])
    : undefined;

  logger.warn(`[ContentTransfer] manifestDiff ${resolved.source.matchPattern} -> ${target.matchPattern}, sections=${sections?.join(',') ?? 'all'}`);

  const [sourceManifest, targetManifest] = await Promise.all([
    getManifest(toCredentials(resolved.source), sections),
    getManifest(toCredentials(target), sections),
  ]);

  return ok(diffManifests(sourceManifest, targetManifest));
}

function parseSelection(raw: unknown): Partial<Record<ManifestSection, string[]>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const selection: Partial<Record<ManifestSection, string[]>> = {};
  for (const [section, identities] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(identities)) continue;
    selection[section as ManifestSection] = identities.filter((i): i is string => typeof i === 'string');
  }
  return selection;
}

async function handleManifestPush(resolved: ResolvedEnvironments, params: Record<string, unknown>): Promise<Envelope<unknown>> {
  const target = findTarget(resolved.all, params.targetMatchPattern);
  if (!target) return fail('unknown_target');

  const sections = Array.isArray(params.sections)
    ? (params.sections as unknown as ManifestSection[])
    : undefined;
  const ignoreDataLossWarnings = params.ignoreDataLossWarnings === true;
  const selection = parseSelection(params.selection);

  logger.warn(
    `[ContentTransfer] manifestPush ${resolved.source.matchPattern} -> ${target.matchPattern}, ` +
    `sections=${sections?.join(',') ?? 'all'}, ignoreDataLossWarnings=${ignoreDataLossWarnings}`,
  );

  // Diffed fresh here (not reusing whatever the UI last previewed) so the
  // apply always acts on a current comparison — the UI's own preview could
  // be stale if either environment changed since it was fetched.
  const [sourceManifest, targetManifest] = await Promise.all([
    getManifest(toCredentials(resolved.source), sections),
    getManifest(toCredentials(target), sections),
  ]);
  const diff = diffManifests(sourceManifest, targetManifest);

  const results = await applyManifestDiff(toCredentials(target), diff, {ignoreDataLossWarnings, selection});

  logger.warn(
    `[ContentTransfer] manifestPush result: ${results.filter((r) => r.success).length}/${results.length} succeeded`,
  );

  return ok({results});
}

export async function handleAction(
  action: string,
  params: Record<string, unknown>,
): Promise<{envelope: Envelope<unknown>; status: number}> {
  try {
    const resolution = await resolveEnvironments(params);
    if (!resolution.ok) {
      return {envelope: describeResolveFailure(resolution.failure), status: 503};
    }
    const resolved = resolution.value;

    switch (action) {
      case 'listEnvironments':
        return {envelope: handleListEnvironments(resolved), status: 200};
      case 'getContentName': {
        const envelope = await handleGetContentName(resolved, params);
        return {envelope, status: envelope.ok ? 200 : (envelope.error === 'not_found' ? 404 : 400)};
      }
      case 'resolveDefaultParent': {
        const envelope = await handleResolveDefaultParent(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'getDestinationRoot': {
        const envelope = await handleGetDestinationRoot(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'listContainerChildren': {
        const envelope = await handleListContainerChildren(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'startPreCheck': {
        const envelope = await handleStartPreCheck(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'getPreCheckProgress': {
        const envelope = await handleGetPreCheckProgress(params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'startTransfer': {
        const envelope = await handleStartTransfer(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'getTransferProgress': {
        const envelope = await handleGetTransferProgress(params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'manifestDiff': {
        const envelope = await handleManifestDiff(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      case 'manifestPush': {
        const envelope = await handleManifestPush(resolved, params);
        return {envelope, status: envelope.ok ? 200 : 400};
      }
      default:
        return {envelope: fail('unknown_action', action), status: 400};
    }
  } catch (error) {
    if (error instanceof CmsError) {
      logger.warn('[ContentTransfer] CMAPI error', action, error.code, error.message);
      return {envelope: fail(error.code, error.message), status: CMS_STATUS[error.code]};
    }
    logger.error('[ContentTransfer] Action failed', action, error);
    return {envelope: fail('internal_error', error instanceof Error ? error.message : undefined), status: 500};
  }
}
