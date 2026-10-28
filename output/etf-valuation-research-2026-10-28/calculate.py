"""Reproduce this read-only research from the captured JSON responses.

Usage: python3 calculate.py /private/tmp/fitgrid-valuation-research
No application/database changes or trading actions.
"""
import bisect
import csv
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

RAW = Path(sys.argv[1])
OUT = Path(__file__).parent
CUTOFF = "2026-10-27"  # Exclude the current session, including its provisional bars.
WINDOW_START = "2021-10-27"


def read(name):
    return json.loads((RAW / (name + ".raw")).read_text())


def valid(value):
    return isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def percentile(history, current):
    """Empirical midrank, excluding the current observation from the reference."""
    ordered = sorted(history)
    assert ordered and all(valid(x) for x in ordered) and valid(current)
    left = bisect.bisect_left(ordered, current)
    right = bisect.bisect_right(ordered, current)
    result = 100 * (left + (right - left) / 2) / len(ordered)
    independent = 100 * sum(1 if x < current else 0.5 if x == current else 0 for x in history) / len(history)
    assert abs(result - independent) < 1e-10
    return round(result, 4)


assert percentile([1, 2, 3], 2) == 50
assert percentile([1, 2, 3], 0.5) == 0
assert percentile([1, 2, 3], 4) == 100

instruments = [
    ("510300.SH", "华泰柏瑞沪深300ETF", "000300.SH", "sh510300"),
    ("510500.SH", "南方中证500ETF", "000905.SH", "sh510500"),
    ("510880.SH", "华泰柏瑞上证红利ETF", "000015.SH", "sh510880"),
    ("SPY.US", "State Street SPDR S&P 500 ETF Trust", "SP500", "SPY"),
    ("QQQ.US", "Invesco QQQ", "NDX", "QQQ"),
]
summaries, observations = [], []
for code, name, index, symbol in instruments:
    result = {"etf": code, "name": name, "index": index}
    if symbol.startswith("sh"):
        original = read("legu-full-" + index)["data"]
        rows = sorted((x for x in original if WINDOW_START <= x["date"] <= CUTOFF), key=lambda x: x["date"])
        fields = {"pe": "addTtmPe", "pb": "addPb", "dividend_yield_percent": "addDvTtm"}
        result["frequency"] = "weekly; current-session observation excluded"
        for metric, field in fields.items():
            usable = [(x["date"], x[field]) for x in rows if valid(x.get(field))]
            date, value = usable[-1]
            result[metric] = {"date": date, "value": value, "reference_count": len(usable) - 1,
                              "reference_start": usable[0][0], "percentile": percentile([v for _, v in usable[:-1]], value)}
            observations.extend({"etf": code, "index": index, "metric": metric, "date": d, "value": v} for d, v in usable)
        data = read("price-" + symbol)["data"][symbol]
        bars = [(x[0], float(x[2])) for x in data.get("qfqday", data.get("day", [])) if x[0] <= CUTOFF]
    else:
        original = read("legu-" + ("sp500" if symbol == "SPY" else "ndx") + "-history")
        assert len(original["xAxis"]) == len(original["series"][1])
        usable = [(d, v) for d, v in zip(original["xAxis"], original["series"][1]) if WINDOW_START <= d <= CUTOFF and valid(v)]
        date, value = usable[-1]
        assert len({d[:7] for d, _ in usable}) == len(usable)
        result.update(frequency="monthly, plus latest observation; null chart points excluded",
                      pe={"date": date, "value": value, "reference_count": len(usable) - 1,
                          "reference_start": usable[0][0], "percentile": percentile([v for _, v in usable[:-1]], value)},
                      pb=None, dividend_yield_percent=None)
        observations.extend({"etf": code, "index": index, "metric": "pe", "date": d, "value": v} for d, v in usable)
        data = read("price-" + symbol)["chart"]["result"][0]
        bars = [(dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d"), v)
                for t, v in zip(data["timestamp"], data["indicators"]["adjclose"][0]["adjclose"]) if valid(v)]
        bars = [(d, v) for d, v in bars if d <= CUTOFF]
    assert len(bars) >= 500 and len({d for d, _ in bars}) == len(bars)
    assert bars == sorted(bars) and all(valid(v) for _, v in bars)
    last = bars[-1][1]
    ma = {str(n): statistics.mean(v for _, v in bars[-n:]) for n in [200, 500]}
    result["price"] = {"date": bars[-1][0], "adjusted_close": last, "history_count": len(bars),
                       "ma200": ma["200"], "ma500": ma["500"], "deviation_ma200_percent": 100 * (last / ma["200"] - 1)}
    # These descriptive closing SMAs differ from the app's intraday dynamic MA.
    summaries.append(result)

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "summary.json").write_text(json.dumps({"cutoff": CUTOFF, "window_start": WINDOW_START,
    "rank_method": "100 * (less + 0.5 * equal) / previous valid observations",
    "not_a_backtest": True, "instruments": summaries}, ensure_ascii=False, indent=2) + "\n")
with (OUT / "valuation-observations.csv").open("w", newline="") as file:
    writer = csv.DictWriter(file, fieldnames=["etf", "index", "metric", "date", "value"])
    writer.writeheader()
    writer.writerows(observations)
manifest = [{"file": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in sorted(RAW.glob("*.raw")) if p.name.startswith(("legu-full-", "legu-sp500-history", "legu-ndx-history", "price-", "csi-", "siblis-", "shiller-xls"))]
(OUT / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(summaries, ensure_ascii=False, indent=2))
