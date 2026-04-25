"""
Lightweight in-process pub/sub for backend → frontend live state.

The daemon (and other backend producers) publish events; the SSE endpoint
streams them to subscribed browsers. Replaces the current model where the
front-end ran the execution loop and pushed events into its own store.

Design choices:
* Per-subscriber thread-safe queue with bounded capacity (drop-oldest on
  overflow, so a slow consumer never blocks a fast producer).
* No replay buffer — clients re-fetch initial state via REST on connect.
* Topic-aware: subscribers can request a subset of topics (``trade``, ``bot``,
  ``portfolio``, ``shadow``, ``job``, ``log``).
"""

from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Optional


EventTopic = str


@dataclass
class Event:
    topic: EventTopic
    payload: dict[str, Any] = field(default_factory=dict)
    ts: float = field(default_factory=lambda: time.time())
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "topic": self.topic, "ts": self.ts, **self.payload}

    def to_sse(self) -> str:
        return f"id: {self.id}\nevent: {self.topic}\ndata: {json.dumps(self.to_dict(), default=str)}\n\n"


class _Subscriber:
    def __init__(self, topics: Optional[set[EventTopic]] = None, max_queue: int = 256):
        self.topics = topics
        self.queue: "queue.Queue[Event]" = queue.Queue(maxsize=max_queue)
        self.dropped = 0

    def matches(self, topic: EventTopic) -> bool:
        if self.topics is None:
            return True
        return topic in self.topics

    def push(self, ev: Event) -> None:
        try:
            self.queue.put_nowait(ev)
        except queue.Full:
            # Drop oldest, append new — keeps the stream live for slow clients.
            try:
                self.queue.get_nowait()
                self.queue.put_nowait(ev)
                self.dropped += 1
            except queue.Empty:
                self.dropped += 1


class EventBus:
    """Process-wide pub/sub. One bus per FastAPI process."""

    def __init__(self) -> None:
        self._subs: list[_Subscriber] = []
        self._lock = threading.Lock()

    def subscribe(self, topics: Optional[Iterable[EventTopic]] = None) -> _Subscriber:
        sub = _Subscriber(set(topics) if topics else None)
        with self._lock:
            self._subs.append(sub)
        return sub

    def unsubscribe(self, sub: _Subscriber) -> None:
        with self._lock:
            try:
                self._subs.remove(sub)
            except ValueError:
                pass

    def publish(self, topic: EventTopic, **payload: Any) -> Event:
        ev = Event(topic=topic, payload=payload)
        with self._lock:
            subs = list(self._subs)
        for s in subs:
            if s.matches(topic):
                s.push(ev)
        return ev

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subs)


# Process-wide singleton used by the SSE endpoint and by all backend producers.
EVENT_BUS = EventBus()
