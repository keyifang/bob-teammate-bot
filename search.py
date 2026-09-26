"""DuckDuckGo search via the `ddgs` library, for tools.js to call.

Why this exists: DuckDuckGo serves a bot-detection challenge page to the
scraped html.duckduckgo.com endpoint once an IP makes a few requests. The
`ddgs` package is a real client rather than a scraper, and is far less likely
to be challenged - verified working from an IP where the scraped endpoint was
returning a 202 challenge page.

Reads one JSON object on stdin: {"query": "...", "maxResults": 5}
Writes one JSON object on stdout: {"ok": true, "results": [{title,url,snippet}]}
or {"ok": false, "error": "..."}. Never raises: an exception would abort the
caller's whole reply.

The library prints progress and warnings to stdout/stderr in some versions, so
the result is emitted on the LAST line as a JSON sentinel and the caller parses
that line rather than assuming clean stdout.
"""

import json
import sys


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:  # noqa: BLE001 - must not raise
        json.dump({"ok": False, "error": f"bad input: {exc}"}, sys.stdout)
        return 0

    query = str(payload.get("query") or "").strip()
    if not query:
        json.dump({"ok": False, "error": "empty query"}, sys.stdout)
        return 0

    try:
        limit = int(payload.get("maxResults") or 5)
    except Exception:  # noqa: BLE001
        limit = 5
    limit = max(1, min(limit, 10))

    try:
        from ddgs import DDGS
    except Exception as exc:  # noqa: BLE001
        _emit({"ok": False, "error": f"ddgs not installed: {exc}"})
        return 0

    try:
        raw = list(DDGS(timeout=20).text(query, max_results=limit))
    except Exception as exc:  # noqa: BLE001 - a rate limit lands here
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0

    results = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = str(item.get("href") or item.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        results.append(
            {
                "title": str(item.get("title") or "").strip(),
                "url": url,
                "snippet": " ".join(
                    str(item.get("body") or item.get("description") or "").split()
                ).strip(),
            }
        )
        if len(results) >= limit:
            break

    _emit({"ok": True, "results": results})
    return 0


def _emit(obj) -> None:
    """Emit the JSON payload as the final line, behind a sentinel.

    Some ddgs versions print progress bars or deprecation notices to stdout,
    which would corrupt a bare json.loads of the whole stream.
    """
    sys.stdout.write("\n@@OWL_SEARCH_JSON@@" + json.dumps(obj) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
