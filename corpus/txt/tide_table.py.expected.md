```python
# Tide table helper (synthetic corpus file)
"""Print the next low tide for a site."""

LOW_TIDES = {"north-inlet": "06:12", "south-bank": "06:40"}

def next_low_tide(site: str) -> str:
    # Unknown sites get a placeholder.
    return LOW_TIDES.get(site, "unknown")

if __name__ == "__main__":
    print(next_low_tide("north-inlet"))

```