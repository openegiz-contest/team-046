"""bz-setup не трогает живое состояние существующих двойников (подменный Ditto в памяти).
Запуск: cd bozshakol/core && python3 -m unittest tests.test_setup"""
import json
import os
import sys
import tempfile
import types
import unittest
import urllib.error

# bzlib тянет paho-mqtt (в образе есть); для теста хватит пустой заглушки
for name in ("paho", "paho.mqtt", "paho.mqtt.client"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["paho.mqtt.client"].Client = object
sys.modules["paho.mqtt.client"].CallbackAPIVersion = types.SimpleNamespace(VERSION2=2)
os.environ.setdefault("DITTO_PASSWORD", "test")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import setup  # noqa: E402


class FakeDitto:
    """Двойники в словаре; PUT целиком, PUT атрибутов и PUT одного признака — как в Ditto."""
    def __init__(self, store):
        self.store = store
        self.calls = []

    def retry(self, fn):
        return fn()

    def get_thing(self, thing_id, fields=None):
        if thing_id not in self.store:
            raise urllib.error.HTTPError("u", 404, "not found", {}, None)
        return json.loads(json.dumps(self.store[thing_id]))

    def put_type(self, thing_id, body):
        """Extended API: PUT /api/types/<id> — тип с _isType=true (ставит платформа)."""
        self.calls.append(("type", thing_id))
        status = 204 if thing_id in self.store else 201
        self.store[thing_id] = dict(json.loads(json.dumps(body)), thingId=thing_id)
        self.store[thing_id]["attributes"]["_isType"] = True
        return status

    def put_thing(self, thing_id, body):
        self.calls.append(("thing", thing_id))
        status = 204 if thing_id in self.store else 201
        self.store[thing_id] = json.loads(json.dumps(body))
        return status

    def _request(self, method, path, body=None):
        self.calls.append((method, path))
        thing = path.split("/api/2/things/")[1].split("/")[0]
        rest = path.split(thing, 1)[1].strip("/").split("/")
        t = self.store[thing]
        if rest == ["attributes"]:
            t["attributes"] = body
        elif rest[0] == "features" and len(rest) == 2:
            t.setdefault("features", {})[rest[1]] = body
        else:
            raise AssertionError(path)
        return 204, None


def twins_dir(core_twins):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "core"))
    with open(os.path.join(d, "core", "twins.json"), "w", encoding="utf-8") as fh:
        json.dump(core_twins, fh)
    return d


class SetupKeepsStateTest(unittest.TestCase):
    def run_setup(self, store, core_twins):
        fake = FakeDitto(store)
        setup.DittoClient = lambda: fake
        setup.ExtendedApi = lambda: fake   # Extended API — тот же подменный Ditto
        os.environ["TWINS_DIR"] = twins_dir(core_twins)
        setup.main()
        return fake

    def test_existing_features_kept_new_added_attrs_updated(self):
        twins = {
            "kz.bozshakol:dispatch": {
                "attributes": {"name": "Диспетчер", "kind": "dispatch", "fleet": 28},
                "features": {"delivered_ore_t": {"properties": {"value": 0}},
                             "trips_total": {"properties": {"value": 0}},
                             "trucks_needed": {"properties": {"value": 0}}},
            },
            "kz.bozshakol:stockpile-new": {"attributes": {"name": "Новый склад"},
                                           "features": {"stock_t": {"properties": {"value": 100}}}},
        }
        store = {"kz.bozshakol:dispatch": {
            "thingId": "kz.bozshakol:dispatch",
            "attributes": {"name": "старое имя", "kind": "dispatch", "runtime_note": "от модуля"},
            "features": {"delivered_ore_t": {"properties": {"value": 141000}},
                         "trips_total": {"properties": {"value": 512}}},
        }}
        self.run_setup(store, twins)
        d = store["kz.bozshakol:dispatch"]
        # накопительные счётчики не сброшены
        self.assertEqual(d["features"]["delivered_ore_t"]["properties"]["value"], 141000)
        self.assertEqual(d["features"]["trips_total"]["properties"]["value"], 512)
        # новый признак добавлен
        self.assertIn("trucks_needed", d["features"])
        # паспортные атрибуты обновлены, чужие атрибуты сохранены
        self.assertEqual(d["attributes"]["name"], "Диспетчер")
        self.assertEqual(d["attributes"]["fleet"], 28)
        self.assertEqual(d["attributes"]["runtime_note"], "от модуля")
        # отсутствующий двойник создан целиком
        self.assertEqual(store["kz.bozshakol:stockpile-new"]["features"]["stock_t"]["properties"]["value"], 100)

    def test_no_whole_put_for_existing(self):
        twins = {"kz.bozshakol:crusher-01": {"attributes": {"name": "Дробилка"},
                                            "features": {"bunker_t": {"properties": {"value": 0}}}}}
        store = {"kz.bozshakol:crusher-01": {"attributes": {"name": "Дробилка"},
                                             "features": {"bunker_t": {"properties": {"value": 640}}}}}
        fake = self.run_setup(store, twins)
        self.assertNotIn(("thing", "kz.bozshakol:crusher-01"), fake.calls)
        self.assertEqual(store["kz.bozshakol:crusher-01"]["features"]["bunker_t"]["properties"]["value"], 640)
        self.assertEqual(fake.calls, [])   # атрибуты не изменились — запросов нет

    def test_scenarios_value_kept_params_updated(self):
        twins = {"kz.bozshakol:scenarios": {"attributes": {"name": "Сценарии"}, "features": {
            "bad_blast": {"properties": {"value": False, "face": "face-01", "p80_mm": 900}}}}}
        store = {"kz.bozshakol:scenarios": {"attributes": {"name": "Сценарии"}, "features": {
            "bad_blast": {"properties": {"value": True, "face": "face-01", "p80_mm": 450}},
            "old_scenario": {"properties": {"value": False}}}}}
        self.run_setup(store, twins)
        f = store["kz.bozshakol:scenarios"]["features"]
        self.assertTrue(f["bad_blast"]["properties"]["value"])          # включён — так и остаётся
        self.assertEqual(f["bad_blast"]["properties"]["p80_mm"], 900)   # параметр — из twins.json
        self.assertIn("old_scenario", f)


    def test_types_created_linked_and_kept_on_rerun(self):
        twins = {
            "kz.bozshakol:truck-01": {"policyId": "default:basic_policy", "attributes": {"name": "Самосвал 01", "kind": "truck"},
                                      "features": {"speed": {"properties": {"value": 0, "unit": "км/ч"}}}},
            "kz.bozshakol:truck-02": {"policyId": "default:basic_policy", "attributes": {"name": "Самосвал 02", "kind": "truck"},
                                      "features": {"speed": {"properties": {"value": 0, "unit": "км/ч"}},
                                                   "fuel": {"properties": {"value": 100, "unit": "%"}}}},
            "kz.bozshakol:crusher-01": {"policyId": "default:basic_policy",
                                        "attributes": {"name": "Дробилка", "kind": "crusher", "type": "гирационная"},
                                        "features": {"bunker": {"properties": {"value": 0, "unit": "т"}}}},
        }
        store = {"kz.bozshakol:crusher-01": {"attributes": {"name": "Дробилка", "kind": "crusher", "type": "гирационная"},
                                             "features": {"bunker": {"properties": {"value": 640, "unit": "т"}}}}}
        fake = self.run_setup(store, twins)
        truck_t, crusher_t = store["kz.bozshakol.types:truck"], store["kz.bozshakol.types:crusher"]
        # типы созданы через Extended API, один на вид; признаки — объединение, значения пустые, единицы сохранены
        self.assertEqual(sorted(c for c in fake.calls if c[0] == "type"),
                         [("type", "kz.bozshakol.types:crusher"), ("type", "kz.bozshakol.types:truck")])
        self.assertTrue(truck_t["attributes"]["_isType"])
        self.assertEqual(truck_t["attributes"]["name"], "Самосвал")
        self.assertEqual(truck_t["features"]["speed"]["properties"], {"value": None, "unit": "км/ч"})
        self.assertIn("fuel", truck_t["features"])
        # двойники ссылаются на тип; своё значение type у дробилки — в crusher_type; живой признак не тронут
        self.assertEqual(store["kz.bozshakol:truck-02"]["attributes"]["type"], "kz.bozshakol.types:truck")
        c = store["kz.bozshakol:crusher-01"]
        self.assertEqual(c["attributes"]["type"], "kz.bozshakol.types:crusher")
        self.assertEqual(c["attributes"]["crusher_type"], "гирационная")
        self.assertEqual(c["features"]["bunker"]["properties"]["value"], 640)
        # повторный запуск: те же id, ничего не создаётся и не пишется
        crusher_t["features"]["note"] = {"properties": {"value": None}}   # дописано вручную в OpenEgiz — не стирается
        again = self.run_setup(store, twins)
        self.assertEqual(again.calls, [])
        self.assertEqual(len([k for k in store if k.startswith("kz.bozshakol.types:")]), 2)
        self.assertIn("note", store["kz.bozshakol.types:crusher"]["features"])


if __name__ == "__main__":
    unittest.main()
