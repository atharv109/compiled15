"""Mock-market simulator: truth calibration, demand model, self-improvement loop.

No LLM inside the market model itself — the ONLY LLM uses are (a) the one-shot
calibration call in truth.py and (b) the reflection/proposal calls in loop.py.
"""