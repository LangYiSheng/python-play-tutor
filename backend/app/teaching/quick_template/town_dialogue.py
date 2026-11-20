"""Dialogue for a reusable course. Subject matter belongs in the selected materials."""


def choice(key, label, next_node):
    return {"id": key, "label": label, "next": next_node}


def line(key, text, *, choices=(), next_node="end", checkpoint=None):
    node = {"id": key, "type": "dialogue", "text": text}
    node.update({"choices": list(choices)} if choices else {"next": next_node})
    if checkpoint:
        node["checkpoint"] = checkpoint
    return node


def route(node, **condition):
    return {"when": condition or {"always": True}, "node": node}


def variations(key, texts, *, choices=()):
    nodes = [line(f"{key}-{i}", text, choices=choices) for i, text in enumerate(texts, 1)]
    return [{"id": key, "type": "random", "next": [node["id"] for node in nodes]}, *nodes]


MAYOR_WELCOME = (
    "欢迎来到学习小镇，{name}！我是镇长。接下来，我们会在这里陪你学习《{course_name}》。"
    "\n\n每章先去图书馆读资料，再到练习会馆找教练，把学到的知识用一用。准备好了就回来找我，我们做一次章节测验。"
)
DEPARTURE = "第一站是镇西的图书馆。你也可以先到处走走，想继续时，看看屏幕左上角的任务目标。"


def mayor_introduction(position, *, ordinary, public_chat):
    leave = choice("leave", "那我先去啦", "mayor-goodbye")
    where = choice("where", "图书管理员在哪里？", "library-location")
    smalltalk = []
    if position == 0:
        opening = line("welcome-mayor", MAYOR_WELCOME, next_node="mayor-departure")
        departure = DEPARTURE
    else:
        greeting = ordinary.welcome if ordinary else ("又见面了，{name}。还记得第一次来大厅时，我给你指过路吗？今天轮到《{chapter_name}》，"
                                                     "学完这最后一章，我们再坐下来聊聊这门课。")
        begin = choice("begin", "开始这一章", "mayor-departure")
        later = choice("later", "我先歇一会儿", "break-before-chapter")
        options = [begin, later]
        if public_chat:
            options.insert(1, choice("chat", "今天镇里有什么新鲜事？", "mayor-smalltalk"))
            replies = ordinary.mayor_chat if ordinary else (
                "刚才馆员来大厅问我，旧书签掉了该拿什么顶上。我想了半天，她已经把一小片废纸折好了。她总是比我手快。",
                "教练刚来借过铅笔，回去才发现耳朵上还夹着一支。下回你见到他，可别笑他，我自己也干过这事。",
                "我喜欢站在大厅门口听一会儿脚步声。有人是来交卷的，有人只是路过跟我招招手。两种我都高兴。",
            )
            smalltalk.extend(variations("mayor-smalltalk", replies, choices=[begin, later]))
        opening = line("welcome-mayor", greeting, choices=options)
        departure = "这章的资料已经放在图书馆了。你照自己的步调来，练完了再回这个大厅找我。"
    nodes = [opening, line("mayor-departure", departure, choices=[where, leave], checkpoint="welcome"),
             line("library-location", "图书馆在镇子西边。走进馆里就能见到图书管理员。平时想重读资料，也可以直接去翻馆里的书架。",
                  next_node="back-to-departure"),
             line("back-to-departure", departure, choices=[leave]),
             line("mayor-goodbye", "回头见，{name}。等你练过了，回来跟我说说哪一部分花的时间最多。")]
    if position:
        nodes.extend(smalltalk)
        nodes.append(line("break-before-chapter", "好，你先逛逛。想开始新一章时，再来找我就行。"))
    return nodes


STAGE_DIALOGUE = {
    "lesson": {
        "first": ("你好呀，{name}，我是图书管理员。每章的学习资料都可以来这里找我。\n\n"
                  "《{chapter_name}》的资料我已经备好了。我们现在一起翻开，还是过一会儿再读？"),
        "last": "来啦，{name}。今天读到最后一章《{chapter_name}》了。现在一起翻开，还是给你留着待会儿再读？",
        "chat_label": "馆里今天忙吗？",
        "chat": (
            "刚给书架掸完灰，数到第三排就忘了自己从哪边数起。下次我打算夹张纸条。你的资料已经在这儿了。",
            "我把掉在桌子底下的几张旧书签收了起来。一张上面画着一只很神气的猫，我还真舍不得拿它夹书。",
        ),
        "ready": ("你回来啦。《{chapter_name}》的资料还在这里，现在翻开吗？",
                  "刚才说到这章的阅读。你要的资料已经备好了，坐下来读一会儿？"),
        "resume": ("欢迎回来，{name}。我们从上次读到的地方往下看吧。", "课件还在。要接着上次那一页读吗？"),
        "start_label": "开始阅读活动", "resume_label": "继续阅读", "later_label": "我先去逛逛",
        "before": "好，翻开资料吧。右侧的学习支持栏里可以查看本次阅读目标，哪里还想再读，你自己决定。",
        "later": "好呀，随时来找我。我就在图书馆里。",
        "paused": "好，先合上吧。下次回到这里，可以从上次的位置接着读。",
    },
    "practice": {
        "first": ("你好，我是练习场教练！听馆员说，你读完了《{chapter_name}》。\n\n"
                  "我替你备了一组练习。拿不准时先自己试一试，再看看题目的反馈。要试第一题吗？"),
        "last": "来，老搭档，《{chapter_name}》的练习给你留好了。这是这门课最后一组，按你自己的步子做就行。",
        "chat_label": "练习会馆今天怎么样？",
        "chat": (
            "我刚把练习桌擦得干干净净，转身自己就按了个手印。干脆开练吧，桌子本来就是留给人用的。",
            "刚才我试着把一摞纸摆齐，越拍越歪。馆员教我先对好一个角。你看，连理桌子我都得跟她学一手。",
        ),
        "ready": ("练习还给你留着。现在要试第一题吗？", "准备好了？我们把刚才读过的内容练一遍。"),
        "resume": ("回来了！我们从还没做完的题接着练。", "要继续上次的练习吗？先看一眼题单，就知道还有哪些要做。"),
        "start_label": "开始知识点练习", "resume_label": "继续练习", "later_label": "稍后再来练",
        "before": "来，先读第一题。可以慢慢试，做完了我们再聊。",
        "later": "没问题。需要的话，先回图书馆看看资料；我在会馆等你。",
        "paused": "今天先练到这里也可以。下次来，接着自己的题单做就好。",
    },
    "assessment": {
        "first": "又见面了，{name}。本章的阅读和练习你都完成了。现在可以独立做《{chapter_name}》的测验，也可以先回去复习。",
        "last": "《{chapter_name}》的练习完成了，{name}。这份是《{course_name}》最后的测验。安心做，交卷以后我在这儿等你。",
        "ready": ("想好了吗？要在这里开始本章的测验吗？", "这份测验等你准备好了再开。现在开始吗？"),
        "resume": ("要回到刚才那份测验吗？交卷前，把每道题都看一遍。", "我们接着这份测验吧。交卷以后，再一起看看结果。"),
        "start_label": "开始章节测验", "resume_label": "继续测验", "later_label": "我想先复习",
        "before": "好，接下来由你独立作答。完成后统一交卷，再回来找我。",
        "later": "当然可以。想复习哪一页就去图书馆看一看，准备好再来。",
        "paused": "我们先停一停。回到大厅后，你还能打开这份测验。",
    },
}


def stage_dialogue(kind, position, *, final, ordinary, public_chat):
    text = STAGE_DIALOGUE[kind]
    start = choice("start", text["start_label"], f"start-{kind}")
    later = choice("later", text["later_label"], f"later-{kind}")
    resume = choice("start", text["resume_label"], f"open-{kind}")
    activity_visit = None
    invitation = text["first"]
    if ordinary:
        if kind == "assessment":
            invitation = ordinary.quiz
        else:
            activity_visit = ordinary.reading if kind == "lesson" else ordinary.practice
            invitation = activity_visit.invitation
    elif final and (position > 0 or kind == "assessment"):
        invitation = text["last"]
    options = [start, later]
    smalltalk = []
    if position > 0 and public_chat and "chat" in text:
        key = f"smalltalk-{kind}"
        options.insert(1, choice("chat", text["chat_label"], key))
        smalltalk = variations(key, activity_visit.chat if activity_visit else text["chat"], choices=[start, later])
    resumes = (activity_visit.resume, *text["resume"]) if activity_visit else text["resume"]
    return [line(f"invite-{kind}", invitation, choices=options, checkpoint=f"meet-{kind}"), *smalltalk,
            *variations(f"ready-{kind}", text["ready"], choices=[start, later]),
            *variations(f"resume-{kind}", resumes, choices=[resume, later]),
            line(f"start-{kind}", text["before"], next_node=f"open-{kind}"),
            line(f"later-{kind}", text["later"]), line(f"paused-{kind}", text["paused"]),
            {"id": f"open-{kind}", "type": "activity", "binding": kind,
             "returns": {"completed": f"done-{kind}", "suspended": f"paused-{kind}", "unavailable": "unavailable"}}]


def chapter_ending(quiz_id, following, *, final, ordinary):
    finish = ordinary.report if ordinary else "《{chapter_name}》这一章学完了，{name}。今天就先到这里，出去走走吧。"
    perfect = ordinary.perfect if ordinary else "这次每道题都答对了。你愿意的话，挑一道想一想，自己当时是怎么判断的？"
    review = ordinary.review if ordinary else "这次有些题还值得再看一眼。挑一道最拿不准的，回书架找找跟它有关的那一页就好。"
    after = ("想继续时，回到大厅找我领取下一章的安排。馆里的书架也随时可以看。" if following else
             "今天这份学习安排已经完成了。想再看一眼哪页资料，就去馆里的书架找找。")
    suggestion = "接下来可以做什么？"
    if final:
        perfect = "最后这份测验，你每道题都答对了。挑一道你最有把握的，试着把理由讲给别人听听。"
        review = "最后这份测验里，还有题值得回头想一想。选一道拿不准的，记下自己卡在哪一步，再找资料对一对。"
        finish = ("{name}，还记得刚到小镇，我给你指去图书馆的路吗？从馆员递给你的第一份资料，到在会馆动手试，再到今天自己交上这张卷子，"
                  "《{course_name}》就这样一步一步学完了。很高兴能陪你走这一程。\n\n"
                  "临走前，给自己留个小问题吧。想一件生活中可能用到所学的事，先试着做第一步。以后路过，也欢迎你回来坐坐。")
        after = "先挑一件你最想自己试的事。想不起第一步，就去书架找一页最有帮助的资料，再合上它试一次。只要能自己往前走一步，就值得高兴。"
        suggestion = "离开以后，我可以怎么练？"
    choices = [choice("break", "我先在镇上逛逛", "end"), choice("next", suggestion, "chapter-handoff")]
    return [line("done-assessment", "卷子已经收好了。我们看看这次的结果。", next_node="score"),
            {"id": "score", "type": "branch", "routes": [
                route("score-all", assessment_score={"activity_id": quiz_id, "min": 100}),
                route("score-review")]},
            line("score-all", perfect, next_node="report"), line("score-review", review, next_node="report"),
            line("report", finish, choices=choices, checkpoint="report"),
            line("chapter-handoff", after)]
