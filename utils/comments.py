"""
Live comment/chat helpers — validation + serialization only.
Kept separate from main.py so the route handlers stay short and the
data rules (name length, image size caps, etc.) live in one place.

Mongo document shape (collection: "comments"):
    {
        _id: ObjectId,
        room: str,            # lecture/name slug this comment belongs to
        client_id: str,       # random id the browser generates once and
                               # keeps in localStorage — used only to let
                               # a user delete their own messages, NOT auth
        name: str,             # <=15 chars, snapshotted at send time
        avatar: str|None,      # data:image/... URL, compressed client-side
        text: str,              # <=1000 chars, stored + rendered as plain text
        image: str|None,        # data:image/... URL, compressed client-side
        created_at: datetime,
    }
"""
from datetime import datetime

MAX_NAME_LEN = 15
MAX_TEXT_LEN = 1000
# Generous caps on the *stored* base64 string length (post client-side
# compression) — keeps Mongo documents small without needing the file
# itself; the picker on the frontend already accepts up to 10MB and
# compresses before this is ever hit.
MAX_AVATAR_STORE_LEN = 2_000_000
MAX_IMAGE_STORE_LEN = 3_000_000


def valid_data_url(value, max_len):
    """Optional field: None/empty is fine. If present, must look like an
    image data URL and stay under the size cap."""
    if value is None or value == "":
        return True
    if not isinstance(value, str):
        return False
    if not value.startswith("data:image/"):
        return False
    if len(value) > max_len:
        return False
    return True


def clean_room(room):
    return (room or "").strip()[:120]


def clean_client_id(value):
    return (value or "").strip()[:64]


def clean_name(value):
    return (value or "").strip()[:MAX_NAME_LEN]


def clean_text(value):
    return (value or "").strip()[:MAX_TEXT_LEN]


def serialize_comment(doc):
    created_at = doc.get("created_at")
    return {
        "_id": str(doc["_id"]),
        "room": doc.get("room"),
        "client_id": doc.get("client_id"),
        "name": doc.get("name") or "Guest",
        "avatar": doc.get("avatar"),
        "text": doc.get("text") or "",
        "image": doc.get("image"),
        "created_at": (created_at.isoformat() + "Z") if created_at else None,
    }
