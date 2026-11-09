// TUI footer label: the effort chosen for the current session, so the
// decision is visible without reading logs.

import { Plugin } from "@opencode/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { DynamicEffort } from "./rpc.ts";

function formatDecision(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const record = data as {
    effort?: unknown;
    variant?: unknown;
    applied?: unknown;
    keyword?: unknown;
  };
  if (typeof record.effort !== "string" || !record.effort) return "";

  const parts = [`effort ${record.effort}`];
  if (typeof record.variant === "string" && record.variant) {
    parts.push(`/${record.variant}`);
  }
  if (record.applied === false) parts.push(" (defaults kept)");
  if (typeof record.keyword === "string" && record.keyword) {
    parts.push(` [${record.keyword}]`);
  }
  return parts.join("");
}

export default Plugin.define({
  id: "dynamic-effort-tui",
  async setup(context) {
    try {
      const rpc = context.client.rpc(DynamicEffort);
      const [labels, setLabels] = createSignal<Record<string, string>>({});
      const requested = new Set<string>();

      const store = (sessionID: string, data: unknown) => {
        setLabels((previous) => ({
          ...previous,
          [sessionID]: formatDecision(data),
        }));
      };

      const refresh = (sessionID?: string) => {
        if (!sessionID || requested.has(sessionID)) return;
        requested.add(sessionID);
        rpc
          .getDecision({ sessionID })
          .then((data) => store(sessionID, data))
          .catch(() => {});
      };

      const off = rpc.events.on("decided", (event) => {
        const data = event.data as { session?: unknown };
        if (typeof data.session === "string") store(data.session, event.data);
      });

      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => {
          refresh(input.sessionID);
          return jsx("text", {
            children: () => labels()[input.sessionID ?? ""] ?? "",
          });
        },
      });

      return () => {
        off();
      };
    } catch {
      // A TUI without the plugin RPC bridge keeps working without a label.
      return;
    }
  },
});
