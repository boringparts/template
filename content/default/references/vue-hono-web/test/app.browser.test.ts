import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-vue";

import { getHealth } from "../src/api.ts";
import App from "../src/App.vue";

it("显示 API 健康状态", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ status: "ok" }),
  );
  const screen = await render(App);
  await expect.element(screen.getByText("API 状态：正常")).toBeVisible();
  vi.restoreAllMocks();
});

it("validates health response status at runtime", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  fetchSpy.mockResolvedValueOnce(Response.json({ status: "degraded" }));
  await expect(getHealth()).resolves.toEqual({ status: "degraded" });

  fetchSpy.mockResolvedValueOnce(Response.json({}));
  await expect(getHealth()).rejects.toThrow(/string status/u);

  fetchSpy.mockResolvedValueOnce(Response.json("bad"));
  await expect(getHealth()).rejects.toThrow(/string status/u);
  vi.restoreAllMocks();
});
