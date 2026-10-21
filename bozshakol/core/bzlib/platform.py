"""Связь с платформой OpenEgiz: Ditto (HTTP) и Mosquitto (MQTT).

Никаких прямых связей между сервисами: всё идёт через платформу.
Порты внутри сети Compose — по именам сервисов (mosquitto:1883, ditto-nginx:80).
"""
import base64
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

import paho.mqtt.client as mqtt

NAMESPACE = "kz.bozshakol"
log = logging.getLogger("bzlib")


def env(name, default=None):
    """Переменная окружения или значение по умолчанию."""
    return os.environ.get(name, default)


def tid(name):
    """Полный thingId по короткому имени; полный thingId возвращается как есть."""
    return name if ":" in name else f"{NAMESPACE}:{name}"


def feature(val, unit=None, **extra):
    """Признак в формате платформы: {"properties": {"value": ..., "unit": ...}}."""
    props = {"value": val}
    if unit is not None:
        props["unit"] = unit
    props.update(extra)
    return {"properties": props}


def value(features, name, default=None):
    """Значение признака из словаря features (как в Ditto)."""
    try:
        return features[name]["properties"]["value"]
    except (KeyError, TypeError):
        return default


# --------------------------------------------------------------------------
class SimClock:
    """Модельное время. Общее для всех сервисов правило: модельное =
    старт + (реальное − старт_реальное) × SIM_SPEEDUP. Смена 12 часов."""

    SHIFT_HOURS = 12
    START = "2026-01-15T08:00:00"  # начало дневной смены

    def __init__(self, speedup=None):
        self.speedup = float(speedup or env("SIM_SPEEDUP", "10"))
        self.start_epoch = time.mktime(time.strptime(self.START, "%Y-%m-%dT%H:%M:%S"))
        self._real_start = time.monotonic()
        self._last = self._real_start
        self._base = 0.0   # модельных секунд от START до запуска сервиса (resume)

    def resume(self, iso):
        """Продолжить модельное время с момента iso (ГГГГ-ММ-ДДTЧЧ:ММ:СС), например с mine.sim_time из Ditto:
        стенд перезапущен, а накопители смены у модулей восстановлены — часы и номер смены идут дальше."""
        start0 = time.mktime(time.strptime(self.START, "%Y-%m-%dT%H:%M:%S"))
        t = time.mktime(time.strptime(str(iso)[:19], "%Y-%m-%dT%H:%M:%S"))
        if t > start0:
            self._base = t - start0
            self.start_epoch = t
            self._real_start = time.monotonic()
            self._last = self._real_start
        return self

    def now(self):
        """Модельное время, секунды с эпохи."""
        return self.start_epoch + (time.monotonic() - self._real_start) * self.speedup

    def iso(self):
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(self.now()))

    def elapsed(self):
        """Модельных секунд с начала работы сервиса."""
        return self._base + (time.monotonic() - self._real_start) * self.speedup

    def shift(self):
        """Номер смены (с 1) и час внутри смены."""
        hours = self.elapsed() / 3600.0
        return int(hours // self.SHIFT_HOURS) + 1, round(hours % self.SHIFT_HOURS, 2)

    def tick(self):
        """Модельных секунд с прошлого вызова (шаг dt)."""
        now = time.monotonic()
        dt = (now - self._last) * self.speedup
        self._last = now
        return dt


# --------------------------------------------------------------------------
class DittoClient:
    """HTTP API Ditto (через ditto-nginx). Пароль — только из окружения."""

    def __init__(self, url=None, user=None, password=None):
        self.url = (url or env("DITTO_URL", "http://ditto-nginx:80")).rstrip("/")
        user = user or env("DITTO_USER", "ditto")
        password = password or os.environ["DITTO_PASSWORD"]
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def _request(self, method, path, body=None, timeout=30):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"Authorization": self.auth, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)

    def retry(self, fn, attempts=20, delay=3):
        for attempt in range(attempts):
            try:
                return fn()
            except urllib.error.HTTPError as exc:
                if exc.code < 500 and exc.code not in (408, 429):
                    raise  # ответ есть, просто не тот (например 404) — повторять бессмысленно
                if attempt == attempts - 1:
                    raise
                log.warning("Ditto ответил %s, повтор через %s с", exc.code, delay)
                time.sleep(delay)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt == attempts - 1:
                    raise
                log.warning("Ditto недоступен (%s), повтор через %s с", exc, delay)
                time.sleep(delay)

    def put_thing(self, thing_id, body):
        return self._request("PUT", f"/api/2/things/{tid(thing_id)}", body)[0]

    def get_thing(self, thing_id, fields="thingId,attributes,features"):
        return self._request("GET", f"/api/2/things/{tid(thing_id)}?fields={fields}")[1]

    def put_feature_value(self, thing_id, feature_name, val):
        """Запись ОДНОГО значения признака (так переключаются сценарии)."""
        return self._request("PUT", f"/api/2/things/{tid(thing_id)}/features/{feature_name}/properties/value", val)[0]

    def search(self, namespace=NAMESPACE, size=200):
        """Снимок всех двойников пространства имён: {thingId: {attributes, features}}."""
        _, body = self._request("GET", f"/api/2/search/things?namespaces={namespace}&option=size({size})"
                                       "&fields=thingId,attributes,features")
        return {item["thingId"]: item for item in body.get("items", [])}


# --------------------------------------------------------------------------
class Telemetry:
    """Публикация признаков своих двойников в MQTT (telemetry/<thingId>) командами
    modify Ditto protocol по пути /features — как полевой шлюз."""

    def __init__(self, host=None, port=None, client_id=None):
        self.host = host or env("MQTT_HOST", "mosquitto")
        self.port = int(port or env("MQTT_PORT", "1883"))
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id or "", protocol=mqtt.MQTTv5)
        self.client.reconnect_delay_set(1, 10)
        self.sent = 0

    def connect(self):
        for attempt in range(60):
            try:
                self.client.connect(self.host, self.port, keepalive=30)
                self.client.loop_start()
                log.info("MQTT подключён: %s:%s", self.host, self.port)
                return self
            except OSError as exc:
                log.warning("MQTT недоступен (%s), повтор %d", exc, attempt + 1)
                time.sleep(2)
        raise RuntimeError("MQTT не ответил")

    def publish(self, thing_id, features):
        """features: {имя: {"properties": {...}}} — все признаки двойника."""
        thing_id = tid(thing_id)
        ns, name = thing_id.split(":", 1)
        message = {
            "topic": f"{ns}/{name}/things/twin/commands/modify",
            "headers": {"response-required": False, "content-type": "application/json"},
            "path": "/features",
            "value": features,
        }
        self.client.publish(f"telemetry/{thing_id}", json.dumps(message, ensure_ascii=False), qos=0)
        self.sent += 1


# --------------------------------------------------------------------------
class TwinWatcher:
    """Чтение чужих двойников только через платформу: снимок по HTTP API Ditto,
    дальше — события исходящего потока Ditto в MQTT (opentwins/twin/events/<ns>/<имя>).
    Потокобезопасно: get() можно звать из цикла моделирования."""

    def __init__(self, ditto, names=None, host=None, port=None, client_id=None):
        """names — короткие имена двойников, которые нужны (None = всё пространство имён)."""
        self.ditto = ditto
        self.names = set(names) if names else None
        self.host = host or env("MQTT_HOST", "mosquitto")
        self.port = int(port or env("MQTT_PORT", "1883"))
        self.twins = {}
        self.updated = {}
        self.lock = threading.Lock()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id or "", protocol=mqtt.MQTTv5)
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(1, 10)

    # -- снимок ----------------------------------------------------------------
    def snapshot(self):
        items = self.ditto.retry(self.ditto.search)
        # Поисковый индекс Ditto отстаёт после создания двойников: нужные по имени берём напрямую
        for name in sorted(self.names or []):
            if tid(name) not in items:
                try:
                    items[tid(name)] = self.ditto.retry(lambda: self.ditto.get_thing(name))
                except urllib.error.HTTPError as exc:
                    log.warning("двойник %s не найден (%s)", name, exc.code)
        with self.lock:
            for thing_id, item in items.items():
                if self._wanted(thing_id):
                    self.twins[thing_id] = {"attributes": item.get("attributes", {}),
                                            "features": item.get("features", {})}
                    self.updated[thing_id] = time.time()
        log.info("снимок: %d двойников", len(self.twins))
        return self

    def _wanted(self, thing_id):
        return self.names is None or thing_id.split(":", 1)[1] in self.names

    # -- события ---------------------------------------------------------------
    def start(self):
        self.snapshot()
        for attempt in range(60):
            try:
                self.client.connect(self.host, self.port, keepalive=30)
                self.client.loop_start()
                return self
            except OSError as exc:
                log.warning("MQTT недоступен (%s), повтор %d", exc, attempt + 1)
                time.sleep(2)
        raise RuntimeError("MQTT не ответил")

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        client.subscribe(f"opentwins/twin/events/{NAMESPACE}/+", qos=0)
        log.info("подписка на события %s", NAMESPACE)

    def _on_message(self, client, userdata, msg):
        try:
            event = json.loads(msg.payload.decode())
            topic = event.get("topic", "")
            parts = topic.split("/")
            if len(parts) < 6 or parts[2] != "things" or parts[4] != "events":
                return
            thing_id = f"{parts[0]}:{parts[1]}"
            if not self._wanted(thing_id):
                return
            self._apply(thing_id, event.get("path", "/"), event.get("value"), parts[5])
        except (ValueError, KeyError, TypeError) as exc:
            log.debug("плохое событие: %s", exc)

    def _apply(self, thing_id, path, val, action):
        with self.lock:
            twin = self.twins.setdefault(thing_id, {"attributes": {}, "features": {}})
            if action == "deleted":
                if path == "/":
                    self.twins.pop(thing_id, None)
                return
            parts = [p for p in path.split("/") if p]
            if not parts:  # весь двойник
                if isinstance(val, dict):
                    twin["attributes"] = val.get("attributes", twin["attributes"])
                    twin["features"] = val.get("features", twin["features"])
            else:
                node = twin
                for key in parts[:-1]:
                    node = node.setdefault(key, {})
                    if not isinstance(node, dict):
                        return
                node[parts[-1]] = val
            self.updated[thing_id] = time.time()

    # -- чтение ----------------------------------------------------------------
    def get(self, name, feature_name, default=None):
        """Значение признака чужого двойника (короткое имя или thingId)."""
        with self.lock:
            twin = self.twins.get(tid(name))
            if not twin:
                return default
            return value(twin["features"], feature_name, default)

    def props(self, name, feature_name):
        """Все properties признака (например параметры сценария)."""
        with self.lock:
            twin = self.twins.get(tid(name))
            try:
                return dict(twin["features"][feature_name]["properties"])
            except (KeyError, TypeError):
                return {}

    def scenario(self, scenario_name):
        """Включён ли сценарий (kz.bozshakol:scenarios) и его параметры."""
        props = self.props("scenarios", scenario_name)
        return bool(props.get("value", False)), props

    def attributes(self, name):
        with self.lock:
            twin = self.twins.get(tid(name))
            return dict(twin["attributes"]) if twin else {}

    def features(self, name):
        with self.lock:
            twin = self.twins.get(tid(name))
            return json.loads(json.dumps(twin["features"])) if twin else {}

    def age(self, name):
        """Секунд с последнего обновления двойника (None — не видели)."""
        with self.lock:
            t = self.updated.get(tid(name))
        return None if t is None else time.time() - t


def setup_logging(name):
    logging.basicConfig(level=logging.INFO, format=f"%(asctime)s {name} %(levelname)s %(message)s")
    return logging.getLogger(name)
