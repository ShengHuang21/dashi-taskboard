import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SubagentRecoveryState } from "./AgentLaneBoard";

afterEach(cleanup);

describe("SubagentRecoveryState", () => {
  it("keeps the automatic-assignment pause visible beside partial active observations", () => {
    render(<SubagentRecoveryState complete={false} activeCount={1} />);

    expect(screen.getByText(/自动分配保持暂停/)).toBeTruthy();
    expect(screen.queryByText(/Root 现在没有启动 Sub-Agent/)).toBeNull();
  });

  it("shows an empty state only after recovery is complete", () => {
    const view = render(<SubagentRecoveryState complete={true} activeCount={0} />);
    expect(screen.getByText(/Root 现在没有启动 Sub-Agent/)).toBeTruthy();

    view.rerender(<SubagentRecoveryState complete={true} activeCount={1} />);
    expect(screen.queryByText(/Root 现在没有启动 Sub-Agent/)).toBeNull();
  });
});
