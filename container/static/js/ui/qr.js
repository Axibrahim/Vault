// Draws a QR code as inline SVG. It is built with DOM calls (no innerHTML, no inline style), so it works
// under Vault's strict content-security policy, and nothing is sent anywhere to make it.
import { encode } from "../vendor/uqr.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const QUIET_ZONE = 2;   // modules of plain space around the code, so cameras can find it

export function drawQr(container, text) {
  const { data, size } = encode(text, { ecc: "M", border: 0 });
  const total = size + QUIET_ZONE * 2;

  let path = "";
  data.forEach((row, y) => {
    for (let x = 0; x < size; x += 1) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < size && row[end + 1]) end += 1;           // one stroke for a whole run of dark squares
      path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(total));
  background.setAttribute("height", String(total));
  background.setAttribute("fill", "#ffffff");

  const modules = document.createElementNS(SVG_NS, "path");
  modules.setAttribute("d", path);
  modules.setAttribute("fill", "#07080a");

  svg.append(background, modules);
  container.replaceChildren(svg);
}

export const clearQr = (container) => container.replaceChildren();