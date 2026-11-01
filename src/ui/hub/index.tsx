import { render } from "preact";
import { Hub } from "./Hub";
import type { HubProps } from "./types";
import "./hub.css";

export type { HubProps, LastRunSummary } from "./types";

export function renderHub(el: HTMLElement, props: HubProps): void {
  render(<Hub {...props} />, el);
}

export function unmountHub(el: HTMLElement): void {
  render(null, el);
}
