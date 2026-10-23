"""Adaptador do Net-Inventory para o Harness² (google-research/harness2)."""

# O harness2.config lê as variáveis no import; o .env deste adaptador precisa vir antes.
from . import env as _env  # noqa: F401
