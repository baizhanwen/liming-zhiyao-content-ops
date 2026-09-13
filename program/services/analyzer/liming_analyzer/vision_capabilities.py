from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

TOKEN_PLAN_KEY_PATTERN = re.compile(r"^sk-cp(?:[-_]|$)", re.IGNORECASE)

VISION_CAPABILITY_REGISTRY = {
    "minimax_token_plan_mcp": {
        "providers": {"minimax", "minimax-token-plan", "minimax_token_plan"},
        "model": "understand_image",
        "supports_images": True,
        "enabled": True,
    },
    "openai_compatible": {
        "providers": {"openai", "openai-compatible", "glm", "zhipu", "qwen", "dashscope"},
        "model_markers": (
            "gpt-4o",
            "gpt-4.1",
            "vision",
            "glm-4v",
            "glm-4.5v",
            "glm-4.6v",
            "qwen-vl",
            "qwen2.5-vl",
            "qwen3-vl",
        ),
        "supports_images": True,
        "enabled": True,
    },
}


@dataclass(frozen=True)
class VisionCapability:
    adapter: str | None
    supported: bool
    provider: str
    model: str
    api_host: str
    reason: str


def is_minimax_token_plan_key(value: str) -> bool:
    return bool(TOKEN_PLAN_KEY_PATTERN.match(value.strip()))


def normalize_minimax_token_plan_host(value: str) -> str:
    candidate = value.strip() or "https://api.minimaxi.com"
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return "https://api.minimaxi.com"
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and hostname in {"api.minimaxi.com", "api.minimax.io"}:
        port = f":{parsed.port}" if parsed.port else ""
        return f"https://{hostname}{port}"
    return "https://api.minimaxi.com"


def resolve_vision_capability(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
) -> VisionCapability:
    provider_key = provider.strip().lower()
    model_name = model.strip()
    key = api_key.strip()

    if is_minimax_token_plan_key(key):
        allowed = VISION_CAPABILITY_REGISTRY["minimax_token_plan_mcp"]["providers"]
        if provider_key and provider_key not in allowed:
            return VisionCapability(
                None,
                False,
                provider.strip(),
                model_name,
                normalize_minimax_token_plan_host(base_url),
                "Token Plan Key 与当前视觉提供方不匹配；请将提供方设为 minimax-token-plan。",
            )
        return VisionCapability(
            "minimax_token_plan_mcp",
            True,
            "MiniMax Token Plan",
            "understand_image",
            normalize_minimax_token_plan_host(base_url),
            "使用官方 MiniMax Coding Plan MCP 的 understand_image，不调用 MiniMax-M3 文本聊天接口。",
        )

    if provider_key in VISION_CAPABILITY_REGISTRY["minimax_token_plan_mcp"]["providers"]:
        return VisionCapability(
            None,
            False,
            "MiniMax",
            model_name or "未填写",
            normalize_minimax_token_plan_host(base_url),
            "MiniMax-M3 是文本模型，不能作为当前图片理解入口；需要 sk-cp 开头的 Token Plan Key。",
        )

    required = (provider_key, model_name, key, base_url.strip())
    if not all(required):
        return VisionCapability(
            None,
            False,
            provider.strip(),
            model_name,
            base_url.strip(),
            "独立视觉模型配置不完整。",
        )

    compatible = VISION_CAPABILITY_REGISTRY["openai_compatible"]
    model_key = model_name.lower()
    if provider_key in compatible["providers"] and any(
        marker in model_key for marker in compatible["model_markers"]
    ):
        return VisionCapability(
            "openai_compatible",
            True,
            provider.strip(),
            model_name,
            base_url.strip(),
            "模型名称已在 OpenAI 兼容视觉能力注册表中声明。",
        )

    return VisionCapability(
        None,
        False,
        provider.strip(),
        model_name,
        base_url.strip(),
        "当前提供方/模型没有在视觉能力注册表中声明图片输入能力。",
    )
