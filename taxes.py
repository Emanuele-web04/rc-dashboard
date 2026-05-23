#!/usr/bin/env python3
"""Calculate net amount after Italian forfettario taxes (5% on 67% of gross).

Accepts EUR by default. Append a currency suffix (e.g. ``2400usd``) to convert
from another currency to EUR using live ECB rates from frankfurter.dev.
The amount can also be a math expression, e.g. ``(2400+500)*12`` or
``(2400+500)usd``.
"""

import ast
import json
import operator
import re
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen

TAXABLE_RATE = 0.67
TAX_RATE = 0.05
RATES_URL = "https://api.frankfurter.dev/v1/latest?base={base}&symbols=EUR"
USER_AGENT = "taxes.py/1.0 (+https://github.com/anomalyco/opencode)"
CURRENCY_SUFFIX_RE = re.compile(r"^(.*?)\s*([a-zA-Z]{3})\s*$")

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def calculate_net(gross: float) -> tuple[float, float]:
    taxable = gross * TAXABLE_RATE
    tax = taxable * TAX_RATE
    net = gross - tax
    return net, tax


def fetch_rate_to_eur(currency: str) -> float:
    """Return how many EUR equals 1 unit of ``currency`` (live ECB rate)."""
    currency = currency.upper()
    if currency == "EUR":
        return 1.0
    url = RATES_URL.format(base=currency)
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=10) as resp:
        data = json.load(resp)
    try:
        return float(data["rates"]["EUR"])
    except KeyError as exc:
        raise ValueError(f"Unsupported currency: {currency}") from exc


def safe_eval(expr: str) -> float:
    """Evaluate a numeric expression with +-*/%** and parentheses only."""
    tree = ast.parse(expr, mode="eval")

    def _eval(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
            return _BIN_OPS[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
            return _UNARY_OPS[type(node.op)](_eval(node.operand))
        raise ValueError(f"Unsupported expression: {expr}")

    return float(_eval(tree))


def parse_amount(raw: str) -> tuple[float, str]:
    """Parse ``"2400"``, ``"2400usd"``, ``"(2400+500)*12"`` or ``"(2400+500)usd"``.

    Returns ``(amount, currency)``. Currency defaults to EUR.
    """
    raw = raw.strip()
    if not raw:
        raise ValueError(raw)

    # Try stripping a trailing 3-letter currency suffix and parsing the rest.
    match = CURRENCY_SUFFIX_RE.match(raw)
    if match and match.group(1).strip():
        expr, currency = match.group(1).strip(), match.group(2).upper()
        try:
            return safe_eval(expr.replace(",", ".")), currency
        except (SyntaxError, ValueError):
            pass  # fall through: maybe the suffix wasn't a currency

    return safe_eval(raw.replace(",", ".")), "EUR"


def print_result(amount: float, currency: str) -> None:
    if currency == "EUR":
        gross_eur = amount
    else:
        try:
            rate = fetch_rate_to_eur(currency)
        except (URLError, ValueError, TimeoutError) as exc:
            print(f"  Conversion failed for {currency}: {exc}")
            return
        gross_eur = amount * rate
        print(f"  Input:              {amount:>12,.2f} {currency}")
        print(f"  Rate:               1 {currency} = {rate:.4f} EUR")

    net, tax = calculate_net(gross_eur)
    print(f"  Gross:              {gross_eur:>12,.2f} EUR")
    print(f"  Taxable base (67%): {gross_eur * TAXABLE_RATE:>12,.2f} EUR")
    print(f"  Tax (5%):           {tax:>12,.2f} EUR")
    print(f"  Net:                {net:>12,.2f} EUR")


def handle(raw: str) -> None:
    try:
        amount, currency = parse_amount(raw)
    except (SyntaxError, ValueError, ZeroDivisionError):
        print(f"  Invalid amount: {raw}")
        return
    print_result(amount, currency)


def main() -> None:
    if len(sys.argv) > 1:
        for arg in sys.argv[1:]:
            handle(arg)
        return

    print("Italian forfettario net calculator (5% on 67% of gross)")
    print("Enter an amount or expression (e.g. 2400, (2400+500)*12, 2400usd).")
    print("Type 'q' to quit.\n")

    while True:
        raw = input("Amount: ")
        if raw.strip().lower() in {"q", "quit", "exit"}:
            break
        if not raw.strip():
            continue
        handle(raw)
        print()


if __name__ == "__main__":
    main()
