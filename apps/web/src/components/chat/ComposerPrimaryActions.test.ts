import { describe, expect, it } from "vite-plus/test";

import {
  formatPendingPrimaryActionLabel,
  MID_TURN_DELIVERY_ACTIONS,
  midTurnPrimaryDeliveryMode,
} from "./ComposerPrimaryActions";

it("offers explicit mid-turn delivery choices", () => {
  expect(MID_TURN_DELIVERY_ACTIONS).toEqual([
    { mode: "steer", label: "Steer now" },
    { mode: "follow-up", label: "Send after completion" },
  ]);
});

it("changes the primary mid-turn action while Ctrl or Cmd is held", () => {
  expect(
    midTurnPrimaryDeliveryMode({ ctrlKey: false, metaKey: false, supportsFollowUp: true }),
  ).toBe("steer");
  expect(
    midTurnPrimaryDeliveryMode({ ctrlKey: true, metaKey: false, supportsFollowUp: true }),
  ).toBe("follow-up");
  expect(
    midTurnPrimaryDeliveryMode({ ctrlKey: false, metaKey: true, supportsFollowUp: true }),
  ).toBe("follow-up");
  expect(
    midTurnPrimaryDeliveryMode({ ctrlKey: true, metaKey: false, supportsFollowUp: false }),
  ).toBe("steer");
});

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});
