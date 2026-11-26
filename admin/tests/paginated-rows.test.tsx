import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "./render-with-toasts";
import { PaginatedRows } from "../src/components/paginated-rows";

it("shows pagination when the eleventh record arrives", async () => {
  const user = userEvent.setup();
  const list = (count: number) => (
    <PaginatedRows rows={Array.from({ length: count }, (_, i) => i + 1)}>
      {visible => <ul>{visible.map(n => <li key={n}>记录 {n}</li>)}</ul>}
    </PaginatedRows>
  );
  const view = render(list(10));
  expect(screen.getAllByRole("listitem")).toHaveLength(10);
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  view.rerender(list(11));
  await user.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("记录 11")).toBeVisible();
});
