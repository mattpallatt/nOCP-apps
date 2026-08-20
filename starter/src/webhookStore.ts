// A minimal, swappable persistence boundary — the only piece of state this
// starter needs at all, now that there's no settings page (see README
// "Why there's no /admin here"). Depend on the WebhookStore interface, not
// a concrete implementation, so swapping storage never touches app.ts.

export interface WebhookEvent {
  id: string;
  receivedUtc: string;
  method: string;
  headers: Record<string, string>;
  bodyText: string | null;
}

export interface WebhookStore {
  record(event: WebhookEvent): Promise<void>;
}

// Default implementation: process memory only. Deliberately the simplest
// thing that satisfies the interface — zero setup, runs anywhere Node
// runs, nothing to provision. The real limitation: most hosts (AWS Lambda
// included) don't guarantee the same process instance handles the next
// request, so this is a demo/local-dev store, not a durable one. Swap in a
// real implementation of WebhookStore (DynamoDB, Postgres, SQLite, a flat
// file, whatever fits) before this matters for anything real — see the
// README's "Swapping the webhook store" section.
const events: WebhookEvent[] = [];
const MAX_KEPT = 50;

export const inMemoryWebhookStore: WebhookStore = {
  async record(event) {
    events.unshift(event);
    events.length = Math.min(events.length, MAX_KEPT);
  },
};
