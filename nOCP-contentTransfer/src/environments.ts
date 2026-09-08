// Port of the source app's src/backend/lib/environments.ts. The real
// change is resolveEnvironmentCredentials: the source read a
// storage.secrets-backed `EnvironmentProfile[]` list by matchPattern; here
// buildEnvironmentProfiles() derives the same shape from the 21 flat
// env1…env3… SettingsValues fields (settingsSchema.ts) on every call — no
// separate storage layer, settingsStore.ts's own 15s cache already keeps
// this cheap. MASKED_SECRET is dropped entirely: settingsStore.ts's
// generic secret-masked handling (cleanValue/toAdminView, driven by
// SETTINGS_SCHEMA) replaces it for every masked field automatically,
// nothing app-specific needed here.
import type {CmapiCredentials} from './cma';
import {getSettings} from './settingsStore';
import type {SettingsValues} from './settingsSchema';

/**
 * One CMS instance's worth of credentials, derived from one env{n}* field
 * group. Content Graph credentials are optional, unlike clientId/
 * clientSecret: without them, transferEngine.ts's title-match ancestor
 * fallback is skipped and an orphaned dependency goes straight to
 * rootContainer instead.
 */
export interface EnvironmentProfile {
  name?: string;
  matchPattern: string;
  clientId: string;
  clientSecret: string;
  rootContainer?: string;
  contentGraphKey?: string;
  contentGraphSecret?: string;
}

// Matches ENVIRONMENT_SLOT_COUNT in settingsSchema.ts — settings.yml-style
// fixed numbered slots, not a dynamically-sized list (nOCP's SettingField[]
// schema has no repeatable-group primitive either, same constraint the
// source app worked around the same way).
export const ENVIRONMENT_SLOT_COUNT = 3;

/**
 * Builds the environment list from settings — a slot is only included if
 * its Match Pattern is non-empty; an all-blank slot 2/3 simply isn't a
 * profile at all (not an empty-string profile that would wrongly match
 * every hostname via `"".includes()` semantics in
 * findEnvironmentForHostname below).
 */
export function buildEnvironmentProfiles(settings: SettingsValues): EnvironmentProfile[] {
  const profiles: EnvironmentProfile[] = [];
  for (let n = 1; n <= ENVIRONMENT_SLOT_COUNT; n++) {
    const record = settings as unknown as Record<string, string>;
    const matchPattern = normalizeCmsDomain(record[`env${n}MatchPattern`] ?? '');
    if (!matchPattern) continue;
    profiles.push({
      name: record[`env${n}Name`] || undefined,
      matchPattern,
      clientId: record[`env${n}ClientId`] ?? '',
      clientSecret: record[`env${n}ClientSecret`] ?? '',
      // Normalized here, not just at settings-save time, so a value saved
      // before this normalization existed (or pasted in hyphenated GUID
      // form some other way) self-heals on every read rather than needing
      // a manual re-save. Confirmed live: CMAPI's GET /v1/content/{key}
      // (used by getContentDisplayName for the destination tree's root
      // label) 404s on a hyphenated key even though /items child listings
      // still work — CMAPI always returns bare keys for children, so only
      // the root, read straight from this typed setting, was ever
      // affected.
      rootContainer: record[`env${n}RootContainer`] ? normalizeContentKey(record[`env${n}RootContainer`]) : undefined,
      contentGraphKey: record[`env${n}ContentGraphKey`] || undefined,
      contentGraphSecret: record[`env${n}ContentGraphSecret`] || undefined,
    });
  }
  return profiles;
}

/** Re-resolves one environment's full CMAPI (+ optional Content Graph) credentials from settings by matchPattern — called fresh on every checkpoint rather than carried through job state, same as the source app re-read storage.secrets fresh on every prepare() call. */
export async function resolveEnvironmentCredentials(
  matchPattern: string,
): Promise<CmapiCredentials & {rootContainer?: string; contentGraphKey?: string; contentGraphSecret?: string}> {
  const settings = await getSettings();
  const profiles = buildEnvironmentProfiles(settings);
  const profile = profiles.find((env) => env.matchPattern === matchPattern);
  if (!profile) {
    throw new Error(`Environment "${matchPattern}" is no longer configured.`);
  }
  return {
    clientId: profile.clientId,
    clientSecret: profile.clientSecret,
    rootContainer: profile.rootContainer,
    contentGraphKey: profile.contentGraphKey,
    contentGraphSecret: profile.contentGraphSecret,
  };
}

/**
 * Strips a leading `scheme://` and anything from the first `/` onward, so a
 * Match Pattern value works the same whether the admin typed a bare domain
 * ("test1", "unrv01saaskq57wt001") or pasted a full URL copied straight out
 * of their browser's address bar — a value saved with the `https://` prefix
 * intact would never match anything, since the hostname extracted from
 * `_diag.href` never contains a scheme.
 */
export function normalizeCmsDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
}

/**
 * CMS SaaS content keys are 32 hex characters with no hyphens, but a GUID
 * copied out of the CMS admin UI or any other tool is typically displayed
 * in the standard hyphenated 8-4-4-4-12 form. Strips hyphens and lowercases
 * so a value pasted either way resolves to the same key.
 */
export function normalizeContentKey(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '');
}

/** The label to show for this environment anywhere the UI names it — the admin-chosen name, falling back to matchPattern if left blank. */
export function environmentDisplayName(profile: EnvironmentProfile): string {
  return profile.name?.trim() || profile.matchPattern;
}

/**
 * Finds which configured environment a sidebar call belongs to, by matching
 * `matchPattern` as a case-insensitive substring of the iframe's own
 * hostname. First match wins.
 *
 * `localhost`/`127.0.0.1` is special-cased to the first configured slot —
 * that hostname never matches a real matchPattern and there's nothing
 * meaningful to match against, so the first configured environment stands
 * in rather than failing outright during local testing.
 */
export function findEnvironmentForHostname(profiles: EnvironmentProfile[], hostname: string): EnvironmentProfile[] {
  const needle = normalizeCmsDomain(hostname);
  if (needle === 'localhost' || needle === '127.0.0.1') {
    return profiles.slice(0, 1);
  }
  return profiles.filter((profile) => needle.includes(normalizeCmsDomain(profile.matchPattern)));
}

/** Safely pulls a hostname out of a URL string; null on anything unparseable rather than throwing. */
export function extractHostname(href: unknown): string | null {
  if (typeof href !== 'string' || !href) return null;
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

/**
 * Resolves the real CMS admin hostname from invokeAction.ts's `_diag`
 * payload — deliberately NOT `diag.href` first. The source app's own
 * version of this (see the original CmsUiExtension.ts) read `_diag.href`
 * directly, which was correct there because OCP's extension iframe is
 * embedded same-origin-ish under the CMS's own domain, so
 * `window.location.href` genuinely was the CMS admin page's URL. nOCP's
 * embedding model is different: this widget is served from its own Lambda
 * Function URL and loaded cross-origin into the CMS sidebar by the Chrome
 * extension, so `window.location.href` inside the widget is always *this
 * app's own URL* — using it here would resolve every request to this
 * Lambda's own hostname, which never matches any configured Match Pattern
 * (confirmed live: this exact failure, "sidebar is running on
 * <lambda-url>.lambda-url.us-east-1.on.aws").
 *
 * `ancestorOrigins[0]` (Chrome/Edge-only, but this is a Chrome-extension
 * app) is the immediate parent frame's origin — the real CMS admin page —
 * and is exactly what invokeAction.ts's captureEmbeddingDiagnostics()
 * already captures into `_diag.ancestorOrigins`, just previously unused
 * server-side. `document.referrer` is the fallback for a browser without
 * `ancestorOrigins` support; `href` is the last resort (better than
 * nothing if somehow both are unavailable, even though it'll usually be
 * wrong for this app specifically).
 */
export function extractSourceHostname(diag: {href?: unknown; ancestorOrigins?: unknown; referrer?: unknown}): string | null {
  const ancestorOrigins = diag.ancestorOrigins;
  if (Array.isArray(ancestorOrigins) && typeof ancestorOrigins[0] === 'string') {
    const hostname = extractHostname(ancestorOrigins[0]);
    if (hostname) return hostname;
  }
  if (typeof diag.referrer === 'string' && diag.referrer) {
    const hostname = extractHostname(diag.referrer);
    if (hostname) return hostname;
  }
  return extractHostname(diag.href);
}
