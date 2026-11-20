"""Recognize unchanged indoor story graphs from before configurable chapter endings."""

from app.course_instances import remap_references
from app.teaching.quick_template.compiler import chapter_prefix
from app.teaching.quick_template.features import route_options
from app.teaching.quick_template.plan import digest


# Fingerprints of the published graphs. Only typed activity references vary between courses.
_DIRECTIONS = "3af9a586f516f1416a27403739dc45d39575fffaa8c3c05bf5d0cd1a5ea89886"
_ENTRIES = "5a1a38c4adbb654e1616acaa7ba5f29a5070b4dba123f4cb43097a73a69e3977"
_NODES = {  # (initial, last selected)
    (True, False): "007c12d9317b94d2f1ea206e4cd8573622e5b1eccd59b4b0a92c082ba4976bda",
    (True, True): "353fd59b755037d0f7ced426d22839ae4127526ae915902cbe6908a36ac65234",
    (False, False): "6699a31fd36b196878ce876f5e54f7aeeb6329c0d2bc2b302e0acbd5cba26ee7",
    (False, True): "f760c058246ca388bbc19316c9a1f50bf36cbb4f14b07512d3b7cbbeb47f100b",
}

# Old familiar greetings repeated after six ordinary chapters. The two inner
# indices are whether public chat was enabled and whether another chapter followed.
_ORDINARY_NODES = (
    (("1e86876e2174dc907bf54737cfed8822cfe4165b6b5d16e1bb820f1f573838bb", "09541074238793e8f957ee7d52191ddbb99b6c9039ae28cb4f2026608ce46b12"),
     ("d72b3536ce55f8d8c53dd67a8ad2d57eb47ca0624cc3da923a847c2040149bad", "a9dd139c8ddd0ba541dfd5c096c7589d63b7628808bab9544f752f818f71a381")),
    (("108b9545b1005f6e14bc23d274ca3e6bbf51f16f1fe1ff484563dca37c245a15", "7f8a3cf287468f4a4c607d119a6a1a7df194bb99dc0e1b5a47b788862bcb680f"),
     ("0975a2261e37bedc529a1f769daf5dfa8620a07bf67b948bbefac117935e2a7b", "ddfba6d1450814bb94ec0e3b44aa7b8c2524af96a723cd80d482ff90cdc01683")),
    (("3b5cdbef7800298c81998e1e627abf84d454d14eb2e3b42ee9c1ad8bfc50a5d4", "8d91cd52994ae75697864e29309e8cccaf4aba2eb0c75e6acb5cf4246a39009a"),
     ("fc5f02d83c595276425910ed25dcc40cb41cd9db977fd227f6fac978a918de72", "f23231560e9c7cbfbf50cef6c5665d34c86d6acd11ddcfe5433bb8bbab84ab59")),
    (("17d5b27f82b92e41e5179f5da194aa41276eb75e6695eb3c4634523b10faa043", "711cf73c2664cfe38bad28d28ed650795e5361493d94fb22ae77e8b58b6e20b6"),
     ("6564c6722a4ad723b75922c949960c7986fa22889e859ea33605aa882a0651f7", "27b3ddb49492ac4e38eaf3d6fe990b2f6b3caee6a9c3d9d6cacb20e86fe256e5")),
    (("bd5133d5514b51ae32955e15317f3b05966c3295fd616e98c33d5f1e77c33cab", "979087a2594890bd08bf9657a2bdaaecee5f29de397e3ccfede9d09af260f45e"),
     ("964e06a4110f9e423a7112b4771eaad467a2350ff8f6cdda81489bbd74410e33", "a01e4386dd7e165c518e1ebf82a52b801d235a1f94fe11b2dc8111716d678e99")),
    (("77032f170e2ecd1977ef198ebafa8cc5655af187130b29c6dcb75662d3e27ee7", "f67cac16511cc4d252fb5d65c49ba5c9b734614ef6cdbb184a9db6c86e53dcdf"),
     ("848c818efe4373408044fcbbb2c7dfecab3c01b3578d79aac8868179ee0ce526", "25a3cf2b1b6ee3ee8f245ab3c8ab9939e637d869349a4f646c4f88370a9f37d8")),
)


def _node_hash(nodes, prefix):
    stage_ids = {prefix + "-" + kind: kind for kind in ("lesson", "practice", "assessment")}
    try:
        return digest(remap_references(nodes, {"activity": stage_ids}))
    except (KeyError, ValueError):
        # A teacher may have introduced additional typed references.
        return None


def restore_ordinary_fingerprints(owned, actual, expected, recipe):
    """Restore only complete, unchanged previous ordinary chapters as template-owned."""
    chapters = [row["chapter_id"] for row in recipe["chapters"]]
    final, features = route_options(recipe, chapters)
    for position, chapter in enumerate(chapters[1:], 1):
        prefix = chapter_prefix(chapter)
        key = prefix + "-journey"
        old, new = actual.get(key), expected.get(key)
        if chapter == final or not old or not new or old == new:
            continue
        nodes = old["content"]["nodes"]
        with_new_nodes = {**old, "content": {**old["content"], "nodes": new["content"]["nodes"]}}
        hashes = _ORDINARY_NODES[(position - 1) % len(_ORDINARY_NODES)]
        known = hashes["public_chat" in features][position < len(chapters) - 1]
        if with_new_nodes == new and _node_hash(nodes, prefix) == known:
            owned[key] = digest(old)


def restore_story_fingerprints(owned, actual, expected, chapters):
    """Only a verified old graph may be replaced by the new template on apply."""
    public = "quick-course-directions"
    if public in actual and actual[public] != expected[public]:
        if digest(actual[public]) == _DIRECTIONS:
            owned[public] = _DIRECTIONS
        else:
            owned.pop(public, None)
    for pos, selection in enumerate(chapters):
        prefix = chapter_prefix(selection["chapter_id"])
        key = prefix + "-journey"
        old, new = actual.get(key), expected[key]
        if not old or old == new:
            continue
        # All fields outside the entry table and nodes are identical between these versions.
        graph = old["content"]
        replace_graph = {**old, "content": {**graph, "entries": new["content"]["entries"], "nodes": new["content"]["nodes"]}}
        if replace_graph == new and digest(graph["entries"]) == _ENTRIES:
            if _node_hash(graph["nodes"], prefix) == _NODES[(pos == 0, pos == len(chapters) - 1)]:
                owned[key] = digest(old)
                continue
        owned.pop(key, None)
