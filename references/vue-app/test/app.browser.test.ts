import { createPinia } from "pinia";
import { expect, it } from "vitest";
import { render } from "vitest-browser-vue";

import App from "../src/App.vue";

it("renders the app and updates the local counter", async () => {
  const screen = await render(App, { global: { plugins: [createPinia()] } });
  const button = screen.getByRole("button", { name: /计数/ });
  await expect.element(button).toHaveTextContent("计数：0");
  await button.click();
  await expect.element(button).toHaveTextContent("计数：1");
});
