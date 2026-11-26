"""Global teaching roles and their authenticated image resources."""
from io import BytesIO
import json

from PIL import Image


def test_roles_apply_globally_and_upload_is_atomic(client, admin_account, teacher, student):
    path = "/api/admin/teaching-roles"
    admin = admin_account["headers"]
    assert client.get(path, headers=teacher["headers"]).status_code == 403
    catalogue = client.get(path, headers=admin).json()
    assert [r["key"] for r in catalogue["roles"]] == ["librarian", "professor", "coach", "mayor"]
    professor = catalogue["roles"][1]
    assert professor["sprite"]["id"] == "builtin:sprite:chara_24"
    config = {"expected_revision": 0, "name": "教授", "persona": "从概念开始",
              "portrait": professor["portrait"]["id"], "sprite": "upload"}
    def save(data, image=None):
        files = {"sprite": ("test.png", image, "image/png")} if image is not None else {}
        return client.post(path + "/professor", headers=admin, data={"metadata": json.dumps(data)}, files=files)
    assert save(config, b"invalid").status_code == 422
    raw = BytesIO()
    Image.new("RGBA", (48, 80), "green").save(raw, "PNG")
    response = save(config, raw.getvalue())
    assert response.status_code == 200, response.text
    role = response.json()
    assert role["persona"] == "从概念开始" and role["revision"] == 1
    url = role["sprite"]["url"]
    assert client.get(url).status_code == 401
    assert client.get(url, headers=student["headers"]).content == raw.getvalue()
    assert save(config, raw.getvalue()).status_code == 409
    response = save({**config, "expected_revision": 1, "sprite": professor["sprite"]["id"]})
    assert response.status_code == 200
    assert client.get(url, headers=student["headers"]).status_code == 404
