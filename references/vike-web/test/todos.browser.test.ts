import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";

import { onAddTodo, onLoadTodos } from "../pages/index/+Page.telefunc.ts";
import Page from "../pages/index/+Page.vue";

vi.mock("../pages/index/+Page.telefunc.ts", () => ({
  onLoadTodos: vi.fn(),
  onAddTodo: vi.fn(),
}));

it("loads todos and refreshes the list after adding one", async () => {
  vi.mocked(onLoadTodos)
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      {
        id: 1,
        title: "Finish todo",
        completed: false,
        createdAt: "2026-10-22",
      },
    ]);
  const screen = await render(Page);
  await screen.getByPlaceholder("添加一条数据库待办").fill("Finish todo");
  await screen.getByRole("button", { name: "添加", exact: true }).click();
  await expect.element(screen.getByText("Finish todo")).toBeVisible();
  expect(onAddTodo).toHaveBeenCalledWith("Finish todo");
});

it("allows retrying after loading fails", async () => {
  vi.mocked(onLoadTodos)
    .mockRejectedValueOnce(new Error("Database unavailable"))
    .mockResolvedValue([]);
  const screen = await render(Page);
  await expect
    .element(screen.getByText("待办加载失败：Database unavailable"))
    .toBeVisible();
  await screen.getByRole("button", { name: "刷新待办事项" }).click();
  await expect
    .element(screen.getByText("待办加载失败：Database unavailable"))
    .not.toBeInTheDocument();
});
