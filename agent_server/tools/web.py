"""Web search and page reading. Open source and keyless (ported from deck-creator-agent).

* ``ddgs`` (MIT): metasearch over DuckDuckGo, Bing, Brave, Mojeek, Wikipedia, ...
* SearXNG (AGPL-3.0, self-hosted, optional): set SEARXNG_URL to use it instead of ddgs.
* Wikipedia's MediaWiki API: fallback when metasearch is rate-limited or finds nothing.
* ``trafilatura`` (Apache-2.0): main-content extraction from HTML, as markdown.
* ``pypdf`` (BSD-3): text of PDF results.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import io
import ipaddress
import os
import re
import socket
from typing import Any, Protocol
from urllib.parse import quote, urlparse

import httpx

from agent_server.tools.base import ToolContext, ToolError, ToolResult, ToolSpec, obj

USER_AGENT = os.environ.get("AGENT_USER_AGENT",
                            "vllm-chat-agent/0.1 (+https://github.com/chaliharohan2/vllm_testing_ui)")
MAX_PAGE_BYTES = 8 * 1024 * 1024
DEFAULT_FETCH_CHARS = 12_000
MAX_FETCH_CHARS = 40_000


# --------------------------------------------------------------------------- safety
def check_url(url: str, allow_private: bool = False) -> None:
    """Reject non-HTTP(S) URLs and hosts on private/loopback networks, so a prompt-injected
    page cannot steer the agent into reading services on this machine or LAN."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ToolError(f"only http(s) URLs are supported, got {url!r}")
    host = parsed.hostname
    if not host:
        raise ToolError(f"invalid URL {url!r}")
    if allow_private:
        return
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        raise ToolError(f"refusing to fetch private host {host!r}")
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addresses = [ipaddress.ip_address(info[4][0].split("%")[0]) for info in socket.getaddrinfo(host, None)]
        except (socket.gaierror, UnicodeError):
            return  # cannot resolve locally (e.g. behind a proxy); let the HTTP client decide
    for ip in addresses:
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ToolError(f"refusing to fetch {host!r}: it resolves to a private address")


def _allow_private() -> bool:
    return os.environ.get("AGENT_WEB_ALLOW_PRIVATE", "").lower() in ("1", "true", "yes")


def _http_client(allow_private: bool, timeout: float = 20.0) -> httpx.Client:
    def guard(request: httpx.Request) -> None:  # runs for every redirect hop too
        check_url(str(request.url), allow_private)

    return httpx.Client(
        follow_redirects=True, timeout=timeout,
        headers={"User-Agent": USER_AGENT,
                 "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
                 "Accept-Language": "en-US,en;q=0.8"},
        event_hooks={"request": [guard]})


def _read_capped(response: httpx.Response, limit: int) -> bytes:
    chunks, size = [], 0
    for chunk in response.iter_bytes():
        size += len(chunk)
        if size > limit:
            raise ToolError(f"response is larger than {limit // (1024 * 1024)} MB")
        chunks.append(chunk)
    return b"".join(chunks)


# --------------------------------------------------------------------------- search backends
class SearchBackend(Protocol):
    name: str

    def text(self, query: str, max_results: int) -> list[dict[str, str]]: ...


class DDGSBackend:
    name = "ddgs"

    def __init__(self, region: str = "us-en", safesearch: str = "moderate", timeout: int = 15):
        self.region, self.safesearch, self.timeout = region, safesearch, timeout

    def text(self, query: str, max_results: int) -> list[dict[str, str]]:
        from ddgs import DDGS
        from ddgs.exceptions import DDGSException

        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
        try:
            rows = DDGS(proxy=proxy, timeout=self.timeout).text(
                query, region=self.region, safesearch=self.safesearch, max_results=max_results)
        except DDGSException as exc:
            if "No results" in str(exc):
                return []
            raise ToolError(f"search failed ({exc}); try again with a different query") from exc
        except Exception as exc:  # noqa: BLE001 - network/library errors: the fallback takes over
            raise ToolError(f"search failed ({exc.__class__.__name__}); try again with a different query") from exc
        return [{"title": r.get("title", ""), "url": r.get("href", ""), "snippet": r.get("body", "")} for r in rows]


class SearxngBackend:
    """Self-hosted SearXNG (enable the ``json`` format in its settings.yml)."""

    name = "searxng"

    def __init__(self, base_url: str, timeout: float = 15.0):
        self.base_url, self.timeout = base_url.rstrip("/"), timeout

    def text(self, query: str, max_results: int) -> list[dict[str, str]]:
        try:
            with httpx.Client(timeout=self.timeout, trust_env=False) as client:
                r = client.get(f"{self.base_url}/search", params={"q": query, "safesearch": 1, "format": "json"})
        except httpx.HTTPError as exc:
            raise ToolError(f"SearXNG at {self.base_url} is not reachable ({exc.__class__.__name__})") from exc
        if r.status_code == 403:
            raise ToolError("SearXNG refused JSON output: add `json` to `search.formats` in settings.yml")
        if r.status_code != 200:
            raise ToolError(f"SearXNG search failed (HTTP {r.status_code})")
        rows = r.json().get("results", [])[:max_results]
        return [{"title": x.get("title", ""), "url": x.get("url", ""), "snippet": x.get("content", "")} for x in rows]


class WikipediaBackend:
    """Wikipedia full-text search through the official MediaWiki API (free, no key, no scraping)."""

    name = "wikipedia"

    def __init__(self, lang: str = "en", timeout: float = 15.0):
        self.lang, self.timeout = lang, timeout

    def text(self, query: str, max_results: int) -> list[dict[str, str]]:
        params = {"action": "query", "list": "search", "srsearch": query, "srlimit": max_results,
                  "srprop": "snippet", "format": "json", "utf8": 1}
        try:
            with httpx.Client(timeout=self.timeout, headers={"User-Agent": USER_AGENT}) as client:
                r = client.get(f"https://{self.lang}.wikipedia.org/w/api.php", params=params)
        except httpx.HTTPError as exc:
            raise ToolError(f"Wikipedia search failed ({exc.__class__.__name__})") from exc
        if r.status_code != 200:
            raise ToolError(f"Wikipedia search failed (HTTP {r.status_code})")
        rows = r.json().get("query", {}).get("search", [])
        return [{"title": f"{row['title']} - Wikipedia",
                 "url": f"https://{self.lang}.wikipedia.org/wiki/{quote(row['title'].replace(' ', '_'))}",
                 "snippet": html_lib.unescape(re.sub(r"<[^>]+>", "", row.get("snippet", "")))} for row in rows]


class FallbackBackend:
    """Use ``primary``; when it returns nothing or fails, ask ``fallback`` instead."""

    def __init__(self, primary: SearchBackend, fallback: SearchBackend):
        self.primary, self.fallback = primary, fallback
        self.name = f"{primary.name}+{fallback.name}"

    def text(self, query: str, max_results: int) -> list[dict[str, str]]:
        primary_error: ToolError | None = None
        try:
            rows = self.primary.text(query, max_results)
        except ToolError as exc:
            rows, primary_error = [], exc
        if rows:
            return rows
        try:
            rows = self.fallback.text(query, max_results)
        except ToolError:
            rows = []
        if not rows and primary_error:
            raise primary_error
        return rows


def make_search_backend() -> SearchBackend:
    searxng = os.environ.get("SEARXNG_URL", "").strip()
    primary: SearchBackend = SearxngBackend(searxng) if searxng else DDGSBackend(
        region=os.environ.get("AGENT_SEARCH_REGION", "us-en"))
    return FallbackBackend(primary, WikipediaBackend())


# --------------------------------------------------------------------------- formatting / fetching
def format_search_results(rows: list[dict[str, str]]) -> str:
    if not rows:
        return "No results. Try one shorter, broader query (search engines may also be rate-limiting)."
    lines = []
    for i, row in enumerate(rows, 1):
        snippet = re.sub(r"\s+", " ", row.get("snippet", "")).strip()
        if len(snippet) > 300:
            snippet = snippet[:299] + "…"
        lines.append(f"{i}. {row.get('title', '').strip()}\n   URL: {row.get('url', '')}\n   {snippet}")
    return "\n".join(lines)


def _html_title(html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return html_lib.unescape(re.sub(r"\s+", " ", match.group(1))).strip()[:200] if match else ""


_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?([\w.:-]+)""", re.I)


def _decode(data: bytes, content_type: str) -> str:
    match = re.search(r"charset\s*=\s*[\"']?([\w.:-]+)", content_type, re.I)
    meta = None if match else _CHARSET.search(data[:4096])
    charset = match.group(1) if match else meta.group(1).decode("ascii") if meta else "utf-8"
    try:
        return data.decode(charset, errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def extract_page_text(data: bytes, content_type: str, url: str) -> tuple[str, str]:
    """``(title, text)`` for an HTML/PDF/text payload."""
    ctype = content_type.lower()
    if "pdf" in ctype or data[:5] == b"%PDF-":
        from pypdf import PdfReader

        try:
            reader = PdfReader(io.BytesIO(data))
            pages = [page.extract_text() or "" for page in reader.pages[:60]]
        except Exception as exc:  # noqa: BLE001 - malformed PDFs are common
            raise ToolError(f"could not read PDF ({exc.__class__.__name__})") from exc
        title = (reader.metadata.title if reader.metadata and reader.metadata.title else "") or ""
        return str(title), re.sub(r"[ \t]+", " ", "\n".join(pages)).strip()
    if ctype and not any(kind in ctype for kind in ("html", "xml", "text/", "json", "markdown")):
        raise ToolError(f"unsupported content type {content_type!r}")
    html = _decode(data, content_type)
    if any(kind in ctype for kind in ("text/plain", "markdown", "json")):
        return "", html.strip()
    import trafilatura

    text = trafilatura.extract(html, url=url, include_tables=True, include_links=False, include_comments=False,
                               output_format="markdown", favor_precision=True)
    if not text:
        text = trafilatura.extract(html, url=url, include_tables=True, include_comments=False,
                                   output_format="markdown", favor_recall=True)
    if not text:
        body = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body)).strip()
    return _html_title(html), text.strip()


def fetch_page(url: str, max_chars: int = DEFAULT_FETCH_CHARS, allow_private: bool = False) -> tuple[str, str]:
    """``(title, text for the model)``."""
    check_url(url, allow_private)
    try:
        with _http_client(allow_private) as client, client.stream("GET", url) as r:
            if r.status_code >= 400:
                raise ToolError(f"HTTP {r.status_code} for {url}; try another source")
            data = _read_capped(r, MAX_PAGE_BYTES)
            ctype = r.headers.get("content-type", "")
            final_url = str(r.url)
    except httpx.HTTPError as exc:
        raise ToolError(f"could not fetch {url} ({exc.__class__.__name__}); try another source") from exc
    title, text = extract_page_text(data, ctype, final_url)
    if len(text) < 200:
        raise ToolError("the page has little readable text (it may need JavaScript or block bots); try another "
                        "source, or the browser tool if it is on")
    total = len(text)
    if total > max_chars:
        cut = text.rfind("\n", 0, max_chars)
        text = text[: cut if cut > max_chars * 0.7 else max_chars] + \
            f"\n\n[... truncated, {total - max_chars:,} more characters]"
    header = f"Title: {title}\nURL: {final_url}\n\n" if title else f"URL: {final_url}\n\n"
    return title, header + text


# --------------------------------------------------------------------------- tools
async def web_search(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    query = str(args.get("query") or "").strip()
    if not query:
        raise ToolError("query is required")
    limit = max(1, min(int(args.get("max_results") or 8), 15))
    backend = make_search_backend()
    rows = await asyncio.to_thread(backend.text, query, limit)
    return ToolResult(format_search_results(rows), summary=f"{len(rows)} results")


async def web_fetch(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    url = str(args.get("url") or "").strip()
    if not url:
        raise ToolError("url is required")
    max_chars = max(1000, min(int(args.get("max_chars") or DEFAULT_FETCH_CHARS), MAX_FETCH_CHARS))
    title, text = await asyncio.to_thread(fetch_page, url, max_chars, _allow_private())
    return ToolResult(text, summary=title or urlparse(url).netloc)


TOOLS = [
    ToolSpec("web_search", "web_search",
             "Search the web. Returns titles, URLs and snippets. Snippets are short: read the most relevant "
             "pages with web_fetch before relying on them. Use short keyword queries.",
             obj({"query": {"type": "string"},
                  "max_results": {"type": "integer", "description": "1-15, default 8."}}, ["query"]),
             web_search),
    ToolSpec("web_fetch", "web_fetch",
             "Read a web page or PDF by URL and get its main text as markdown (navigation and ads removed). "
             "Pages that need JavaScript may come back empty.",
             obj({"url": {"type": "string"},
                  "max_chars": {"type": "integer",
                                "description": f"Characters to return (default {DEFAULT_FETCH_CHARS}, max "
                                               f"{MAX_FETCH_CHARS})."}}, ["url"]),
             web_fetch),
]
