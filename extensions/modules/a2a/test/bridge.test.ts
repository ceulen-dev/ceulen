/** bridge.test.ts — kernel chained-prompt behavior for a2a's action rows:
 *  an action whose `set` calls the panel prompt TWICE (name → URL) must
 *  resolve both prompts through makeOnAction and mutate the working config.
 *  If the kernel breaks chained prompts, the pre-decided fallback is
 *  single-prompt parse flows — this test is the tripwire. */
import { describe, it } from "node:test";
import { assert } from "./chai.js";
import { makeOnAction, type ConfigPanelModel, type PanelGroup, type PanelRow } from "../../../lib/panel.js";

function fakeModel(): ConfigPanelModel & { prompts: Array<{ label: string; answer: (v: string | undefined) => void }>; rebuilt: number } {
  const prompts: Array<{ label: string; answer: (v: string | undefined) => void }> = [];
  const model: any = {
    prompts,
    rebuilt: 0,
    dirty: false,
    setGroups: () => {
      model.rebuilt += 1;
    },
    requestRender: () => {},
    // The kernel's inline prompt: register the pending input; the test
    // resolves it via prompts[i].answer().
    prompt: (label: string, onDone: (v: string | undefined) => void) => {
      prompts.push({ label, answer: onDone });
    },
  };
  return model as ConfigPanelModel & typeof model;
}

describe("makeOnAction chained prompts (a2a add flows)", () => {
  it("an action calling prompt() twice resolves both and rebuilds after each", async () => {
    const model = fakeModel();
    const working: Record<string, string> = {};
    const groups = (): PanelGroup[] => [
      {
        key: "g",
        label: "g",
        rows: [
          {
            key: "a2a.action.add",
            label: "+ add",
            kind: "action",
            value: undefined,
            set: (prompt: (label: string, onDone: (v: string | undefined) => void) => void) => {
              (prompt as (l: string, d: (v: string | undefined) => void) => void)("name", (name) => {
                if (!name) return;
                (prompt as (l: string, d: (v: string | undefined) => void) => void)("url", (url) => {
                  if (!url) return;
                  working[name] = url;
                });
              });
            },
          } as unknown as PanelRow,
        ],
      },
    ];
    const onAction = makeOnAction(model as never, {}, groups as never, {}, () => {});
    const row = groups()[0]!.rows[0]!;
    const done = onAction(row);
    // First prompt opens synchronously inside row.set.
    assert.lengthOf(model.prompts, 1, "first prompt (name) open");
    assert.equal(model.prompts[0]!.label, "name");
    model.prompts[0]!.answer("lab");
    // Second prompt must have opened during the first resolution.
    assert.lengthOf(model.prompts, 2, "second prompt (url) opens after the first resolves");
    assert.equal(model.prompts[1]!.label, "url");
    model.prompts[1]!.answer("http://x");
    await done;
    assert.equal(working.lab, "http://x", "action mutated the working config through both prompts");
    assert.isTrue(model.dirty, "panel marked dirty");
    assert.isOk(model.rebuilt >= 2, `rebuilt after each prompt resolution (${model.rebuilt})`);
  });

  it("an action calling prompt() once (remove flows) applies on resolution", async () => {
    const model = fakeModel();
    const working: Record<string, string> = { peer: "x" };
    const groups = (): PanelGroup[] => [
      {
        key: "g",
        label: "g",
        rows: [
          {
            key: "a2a.action.remove",
            label: "− remove",
            kind: "action",
            value: undefined,
            set: (prompt: (label: string, onDone: (v: string | undefined) => void) => void) => {
              (prompt as (l: string, d: (v: string | undefined) => void) => void)("name", (pick) => {
                if (pick && working[pick]) delete working[pick];
              });
            },
          } as unknown as PanelRow,
        ],
      },
    ];
    const onAction = makeOnAction(model as never, {}, groups as never, {}, () => {});
    await onAction(groups()[0]!.rows[0]!);
    assert.lengthOf(model.prompts, 1);
    model.prompts[0]!.answer("peer");
    assert.equal(working.peer, undefined, "removal applied");
  });
});
