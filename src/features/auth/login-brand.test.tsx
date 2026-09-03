// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { LoginBrand } from "./login-brand";

it("separates the price ladder and copy into independent layout regions", () => {
  const { container } = render(<LoginBrand />);
  const brand = screen.getByRole("complementary");
  const ladder = container.querySelector("svg");
  const heading = screen.getByRole("heading", { name: "让每一道网格都有清晰依据" });

  expect(ladder).not.toBeNull();
  expect(ladder?.parentElement).not.toBe(brand);
  expect(heading.parentElement).not.toBe(brand);
});
