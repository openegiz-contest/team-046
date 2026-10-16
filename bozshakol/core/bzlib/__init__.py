"""Общая библиотека рудника Бозшаколь (владелец — координатор).

Модули копируют её в свой образ (COPY core/bzlib ./bzlib). Она умеет ровно то,
что требует договор (contract/README.md): публиковать признаки своих двойников
в MQTT сообщениями Ditto protocol, получать снимок чужих двойников через
HTTP API Ditto, следить за их событиями по MQTT и считать модельное время.
"""
from .platform import (  # noqa: F401
    NAMESPACE,
    DittoClient,
    SimClock,
    Telemetry,
    TwinWatcher,
    env,
    setup_logging,
    feature,
    tid,
    value,
)
