export function formatDecimal(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `${negative ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function formatRatioAsPercent(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const decimalIndex = whole.length + 2;
  const digits = `${whole}${fraction}`.padEnd(decimalIndex, "0");
  const percentageWhole = digits.slice(0, decimalIndex).replace(/^0+(?=\d)/, "") || "0";
  const percentageFraction = digits.slice(decimalIndex);
  const percentage = `${negative ? "-" : ""}${percentageWhole}${
    percentageFraction ? `.${percentageFraction}` : ""
  }`;

  return formatDecimal(percentage);
}
