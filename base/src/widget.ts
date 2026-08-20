export {};

interface ContentIdMessage {
  source: "nocp-host";
  type: "content-id";
  contentGuid: string;
  name: string | null;
  contentLink: string | null;
  contentTypeName: string | null;
}

function isContentIdMessage(data: unknown): data is ContentIdMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as Record<string, unknown>).source === "nocp-host" &&
    (data as Record<string, unknown>).type === "content-id"
  );
}

function renderContentInfo(info: ContentIdMessage | null): void {
  const target = document.getElementById("content-info");
  if (!target) return;
  target.textContent = info ? `Page ID ${info.contentGuid}` : "Page ID …";
}

function renderBlocked(): void {
  const target = document.getElementById("app");
  if (!target) return;
  target.textContent = "This app can only be opened from within the CMS sidebar.";
}

// Client-side backstop only — the server already refuses to serve real
// content outside an iframe. This just avoids a confusing blank/loading
// state in the rare case someone reaches this document some other way.
if (window.top === window.self) {
  renderBlocked();
} else {
  const app = document.getElementById("app");
  if (app) {
    const contentInfo = document.createElement("div");
    contentInfo.id = "content-info";
    app.appendChild(contentInfo);
  }

  renderContentInfo(null);

  window.addEventListener("message", (event: MessageEvent) => {
    if (!isContentIdMessage(event.data)) return;
    renderContentInfo(event.data);
  });
}
