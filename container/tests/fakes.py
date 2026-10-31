"""In-memory stand-ins for Firestore, so the tests never touch the network."""
import copy
from datetime import datetime, timezone

from firebase_admin import firestore
from google.api_core.exceptions import AlreadyExists


def _resolve(value):
    """Firestore swaps SERVER_TIMESTAMP for the real time when it stores a value."""
    if value is firestore.SERVER_TIMESTAMP:
        return datetime.now(timezone.utc)
    return value


class FakeSnapshot:
    def __init__(self, ref, data):
        self.reference = ref
        self.id = ref.id
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return copy.deepcopy(self._data) if self._data is not None else None


class FakeQuery:
    def __init__(self, collection, filters=(), limit=None):
        self._collection = collection
        self._filters = list(filters)
        self._limit = limit

    def where(self, *, filter):
        return FakeQuery(self._collection, [*self._filters, filter], self._limit)

    def limit(self, count):
        return FakeQuery(self._collection, self._filters, count)

    @staticmethod
    def _matches(data, flt):
        value = data.get(flt.field_path)
        if flt.op_string == "==":
            return value == flt.value
        if flt.op_string == "in":
            return value in flt.value
        raise NotImplementedError(flt.op_string)

    def stream(self):
        found = []
        for ref in self._collection.refs():
            data = ref.raw()
            if data is not None and all(self._matches(data, f) for f in self._filters):
                found.append(FakeSnapshot(ref, data))
        return iter(found[: self._limit] if self._limit else found)


class FakeCollection:
    def __init__(self, store, path):
        self._store = store
        self._path = path

    def document(self, doc_id):
        return FakeDocument(self._store, f"{self._path}/{doc_id}")

    def refs(self):
        prefix = self._path + "/"
        for path in sorted(self._store.docs):
            rest = path[len(prefix):]
            if path.startswith(prefix) and "/" not in rest:
                yield FakeDocument(self._store, path)

    def stream(self):
        return FakeQuery(self).stream()

    def where(self, *, filter):
        return FakeQuery(self).where(filter=filter)


class FakeDocument:
    def __init__(self, store, path):
        self._store = store
        self.path = path
        self.id = path.rsplit("/", 1)[1]

    def raw(self):
        return self._store.docs.get(self.path)

    def collection(self, name):
        return FakeCollection(self._store, f"{self.path}/{name}")

    def get(self, transaction=None):
        return FakeSnapshot(self, self.raw())

    def create(self, data):
        if self.path in self._store.docs:
            raise AlreadyExists("document already exists")
        self._store.docs[self.path] = {k: _resolve(v) for k, v in data.items()}

    def set(self, data):
        self._store.docs[self.path] = {k: _resolve(v) for k, v in data.items()}

    def update(self, data):
        self._store.docs[self.path].update({k: _resolve(v) for k, v in data.items()})


class FakeTransaction:
    def create(self, ref, data):
        ref.create(data)

    def update(self, ref, data):
        ref.update(data)


class FakeDb:
    def __init__(self):
        self.docs = {}

    def collection(self, name):
        return FakeCollection(self, name)

    def transaction(self):
        return FakeTransaction()