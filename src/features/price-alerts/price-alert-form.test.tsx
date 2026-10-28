// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PriceAlertForm } from "./price-alert-form";

afterEach(cleanup);
it("keeps MA touch direction selectable and submits days as a number", async () => {
  const user = userEvent.setup();
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<PriceAlertForm onSubmit={submit} />);
  await user.selectOptions(screen.getByLabelText("提醒条件"), "ma_touch");
  await user.selectOptions(screen.getByLabelText("触发方向"), "down");
  await user.clear(screen.getByLabelText("均线天数"));
  await user.type(screen.getByLabelText("均线天数"), "20");
  await user.click(screen.getByRole("button", { name: "保存提醒" }));
  expect(submit).toHaveBeenCalledWith({ condition: { kind: "ma_touch", direction: "down", days: 20 }, enabled: false });
});
it("rejects invalid MA windows and percentages before saving", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(<PriceAlertForm onSubmit={submit} />);
  await user.selectOptions(screen.getByLabelText("提醒条件"), "ma_deviation");
  await user.clear(screen.getByLabelText("均线天数"));
  await user.type(screen.getByLabelText("均线天数"), "251");
  await user.type(screen.getByLabelText("偏离幅度（%）"), "100");
  await user.click(screen.getByRole("button", { name: "保存提醒" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("均线天数必须为 2–250 的整数");
  expect(submit).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText("均线天数"));
  await user.type(screen.getByLabelText("均线天数"), "2");
  await user.click(screen.getByRole("button", { name: "保存提醒" }));
  expect(screen.getByRole("alert")).toHaveTextContent("偏离幅度必须为 0.01–99.99");
});
it("saves a precise price and an explicit enabled state", async () => {
  const user = userEvent.setup(); const submit = vi.fn().mockResolvedValue(undefined);
  render(<PriceAlertForm onSubmit={submit} />);
  await user.type(screen.getByLabelText("目标价格"), "6.9200");
  await user.click(screen.getByLabelText("保存后启用"));
  await user.click(screen.getByRole("button", { name: "保存提醒" }));
  expect(submit).toHaveBeenCalledWith({ condition: { kind: "price", direction: "up", targetPrice: "6.9200" }, enabled: true });
});
it.each([["2", "0.01"], ["250", "99.99"]])("accepts MA deviation boundaries %s days and %s percent", async (days, percent) => {
  const user = userEvent.setup(); const submit = vi.fn().mockResolvedValue(undefined);
  render(<PriceAlertForm onSubmit={submit} />);
  await user.selectOptions(screen.getByLabelText("提醒条件"), "ma_deviation");
  await user.clear(screen.getByLabelText("均线天数")); await user.type(screen.getByLabelText("均线天数"), days);
  await user.type(screen.getByLabelText("偏离幅度（%）"), percent);
  await user.click(screen.getByRole("button", { name: "保存提醒" }));
  expect(submit).toHaveBeenCalledWith({ enabled: false, condition: { kind: "ma_deviation", direction: "up", days: Number(days), percent } });
});
