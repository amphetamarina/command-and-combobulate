export const SIDEBAR_FRACTION = 0.4;
const PANEL_PAD = 12;

type SidebarOptions = {
  onBuildTerminal: () => void;
};

export class Sidebar {
  readonly terminalHost: HTMLDivElement;
  private tabs: HTMLDivElement;

  constructor(private opts: SidebarOptions) {
    const root = document.createElement("div");
    root.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      `width:${SIDEBAR_FRACTION * 100}vw`,
      "height:100%",
      "box-sizing:border-box",
      `padding:${PANEL_PAD}px`,
      "display:flex",
      "flex-direction:column",
      "gap:10px",
      "background:linear-gradient(#241620,#1a121b)",
      "border-right:2px solid #4a2e3e",
      "box-shadow:4px 0 16px rgba(0,0,0,0.5)",
      "font-family:'JetBrains Mono',ui-monospace,monospace",
      "color:#f0d4e0",
      "font-size:13px",
      "z-index:50",
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;gap:12px;flex:none";
    const title = document.createElement("img");
    title.src = "/logo/aiso-logo.png";
    title.alt = "AIso";
    title.style.cssText = "height:30px;width:auto;display:block;flex:none";
    const buildBtn = document.createElement("button");
    buildBtn.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:6px 12px",
      "background:#3a2230",
      "color:#ffb3d1",
      "border:1px solid #5a3a4a",
      "border-radius:4px",
      "font-family:inherit",
      "font-size:13px",
      "cursor:pointer",
    ].join(";");
    buildBtn.append(this.icon(20), this.span("+ Terminal"));
    buildBtn.addEventListener("click", () => this.opts.onBuildTerminal());
    header.append(title, buildBtn);

    this.tabs = document.createElement("div");
    this.tabs.style.cssText =
      "display:flex;flex-wrap:wrap;gap:6px;flex:none;min-height:0";

    this.terminalHost = document.createElement("div");
    this.terminalHost.style.cssText = [
      "flex:1",
      "min-height:0",
      "background:#150d13",
      "border:1px solid #4a2e3e",
      "border-radius:5px",
      "overflow:hidden",
      "padding:6px",
    ].join(";");

    root.append(header, this.tabs, this.terminalHost);
    document.body.appendChild(root);
  }

  private span(text: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.textContent = text;
    return el;
  }

  private icon(size: number): HTMLImageElement {
    const img = document.createElement("img");
    img.src = "/isotop-assets/sci-fi/icons/terminal.png";
    img.width = size;
    img.height = size;
    img.style.cssText = "image-rendering:pixelated;flex:none";
    return img;
  }

  setTerminals(
    ids: string[],
    activeId: string | null,
    onOpen: (id: string) => void,
    onClose: (id: string) => void,
  ): void {
    this.tabs.replaceChildren();
    for (const id of ids) {
      const active = id === activeId;
      const tab = document.createElement("div");
      tab.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:6px",
        "padding:4px 8px",
        `background:${active ? "#4a2a3a" : "#241620"}`,
        `border:1px solid ${active ? "#8a4a6a" : "#4a2e3e"}`,
        "border-radius:4px",
        `color:${active ? "#ffd0e6" : "#c89ab0"}`,
        "font-size:13px",
        "cursor:pointer",
      ].join(";");
      const label = this.span(id);
      label.style.cursor = "pointer";
      label.addEventListener("click", () => onOpen(id));
      const close = this.span("×");
      close.style.cssText = "cursor:pointer;color:#ff8aa8;font-weight:bold";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        onClose(id);
      });
      tab.append(this.icon(16), label, close);
      this.tabs.appendChild(tab);
    }
  }
}
