// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DeliveryProgress } from "../taskProgress";
import { TaskProgress } from "./TaskProgress";

afterEach(cleanup);

describe("TaskProgress compact presentation", () => {
  it("shows only the progress track while retaining detailed accessible evidence", () => {
    const progress: DeliveryProgress = {
      completed: 2,
      total: 4,
      percent: 50,
      reason: null,
      latestChange: {
        id: "change-1",
        kind: "created",
        createdAt: "2026-09-25T12:00:00.000Z",
      },
    };

    render(<TaskProgress progress={progress} label="CAP-49 delivery completion" />);

    const track = screen.getByRole("progressbar", { name: "CAP-49 delivery completion" });
    expect(track.getAttribute("aria-valuenow")).toBe("50");
    expect(track.getAttribute("aria-valuetext")).toMatch(/50%/);
    expect(track.getAttribute("aria-valuetext")).toMatch(/2\/4 deliverables complete/);
    expect(track.getAttribute("aria-valuetext")).toMatch(/Last scope change/);
    expect(track.getAttribute("aria-valuetext")).toMatch(/Sep 25/);
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.queryByText("2/4 deliverables complete")).toBeNull();
    expect(screen.queryByText(/Last scope change/)).toBeNull();
    expect(screen.queryByText(/Sep 25/)).toBeNull();
  });
});
