"""Bounded, anonymous Douyin acquisition with no application credentials."""
from .adapter import CollectorAdapter, CollectorError, collect

__all__ = ['CollectorAdapter', 'CollectorError', 'collect']
