// The footer label is the only part of the plugin a person sees, so it is
// rendered here through the real Solid renderer instead of being trusted.

import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import tui from "../../src/opencode/tui.ts";

type Claim = {
  append: string;
  render: (input: {
    sessionID?: string;
    mode: "normal" | "shell";
    showDetails: boolean;
  }) => unknown;
};

type Handler = (event: { data: unknown }) => void;

function fakeContext() {
  const claims: Claim[] = [];
  const handlers = new Map<string, Handler>();
  const decisions = new Map<string, unknown>();
  const context = {
    client: {
      rpc: () => ({
        getDecision: async ({ sessionID }: { sessionID: string }) =>
          decisions.get(sessionID) ?? {},
        events: {
          on: (name: string, handler: Handler) => {
            handlers.set(name, handler);
            return () => handlers.delete(name);
          },
        },
      }),
    },
    ui: {
      slot: (claim: Claim) => {
        claims.push(claim);
        return () => {};
      },
    },
  };
  return { context, claims, handlers, decisions };
}

function input(sessionID?: string) {
  return { sessionID, mode: "normal" as const, showDetails: false };
}

async function frame(claim: Claim, sessionID?: string) {
  const setup = await testRender(
    () => claim.render(input(sessionID)) as never,
    { width: 40, height: 2 },
  );
  await setup.renderOnce();
  const text = setup.captureCharFrame().split("\n")[0]!.trimEnd();
  return { text, setup };
}

describe("footer label", () => {
  test("shows the effort and the variant the model received", async () => {
    const { context, claims } = fakeContext();
    await tui.setup(context as never);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.append).toBe("prompt.footer.status");

    const { setup } = await frame(claims[0]!, "ses_1");
    setup.renderer.destroy();
  });

  test("names the keyword that forced the level", async () => {
    const { context, claims, handlers } = fakeContext();
    await tui.setup(context as never);

    handlers.get("decided")?.({
      data: { session: "ses_1", effort: "xhigh", variant: "max" },
    });
    const decided = await frame(claims[0]!, "ses_1");
    expect(decided.text).toBe("effort xhigh/max");
    decided.setup.renderer.destroy();
  });

  test("says when the harness kept its own defaults", async () => {
    const { context, claims, handlers } = fakeContext();
    await tui.setup(context as never);

    handlers.get("decided")?.({
      data: { session: "ses_2", effort: "high", applied: false },
    });
    const kept = await frame(claims[0]!, "ses_2");
    expect(kept.text).toBe("effort high (defaults kept)");
    kept.setup.renderer.destroy();
  });

  test("is empty for a session with no decision yet", async () => {
    const { context, claims } = fakeContext();
    await tui.setup(context as never);

    const empty = await frame(claims[0]!, "ses_unknown");
    expect(empty.text).toBe("");
    empty.setup.renderer.destroy();
  });

  test("ignores a decision without an effort", async () => {
    const { context, claims, handlers } = fakeContext();
    await tui.setup(context as never);

    handlers.get("decided")?.({ data: { session: "ses_3", variant: "max" } });
    const ignored = await frame(claims[0]!, "ses_3");
    expect(ignored.text).toBe("");
    ignored.setup.renderer.destroy();
  });

  test("updates in place when the next decision arrives", async () => {
    const { context, claims, handlers } = fakeContext();
    await tui.setup(context as never);

    handlers.get("decided")?.({
      data: { session: "ses_4", effort: "low", variant: "low" },
    });
    const setup = await testRender(
      () => claims[0]!.render(input("ses_4")) as never,
      { width: 40, height: 2 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame().split("\n")[0]!.trimEnd()).toBe(
      "effort low/low",
    );

    handlers.get("decided")?.({
      data: { session: "ses_4", effort: "xhigh", variant: "max" },
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame().split("\n")[0]!.trimEnd()).toBe(
      "effort xhigh/max",
    );
    setup.renderer.destroy();
  });

  test("keeps working when the plugin bridge is missing", async () => {
    await tui.setup({} as never);
  });
});
