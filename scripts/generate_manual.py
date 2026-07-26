from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
OUTPUT_FILE = OUTPUT_DIR / "PromptMemo_利用マニュアル.pdf"
ICON = ROOT / "icons" / "icon-v3-128.png"

PAGE_W, PAGE_H = A4
MARGIN = 42

GREEN = HexColor("#176B4D")
GREEN_DARK = HexColor("#0F573E")
GREEN_SOFT = HexColor("#E2F1EA")
INK = HexColor("#16211D")
MUTED = HexColor("#68756F")
LINE = HexColor("#DCE5E0")
CANVAS = HexColor("#F4F7F5")
BLUE = HexColor("#2563A9")
BLUE_SOFT = HexColor("#E8F1FB")
ORANGE = HexColor("#B15F13")
ORANGE_SOFT = HexColor("#FFF0DF")
RED = HexColor("#B63B3B")
GOLD = HexColor("#E2AA2E")


def register_fonts():
    regular = Path(r"C:\Windows\Fonts\YuGothR.ttc")
    bold = Path(r"C:\Windows\Fonts\YuGothB.ttc")
    if not regular.exists() or not bold.exists():
        regular = Path(r"C:\Windows\Fonts\meiryo.ttc")
        bold = Path(r"C:\Windows\Fonts\meiryob.ttc")
    pdfmetrics.registerFont(TTFont("JP", str(regular)))
    pdfmetrics.registerFont(TTFont("JP-Bold", str(bold)))


def set_font(c, size=10, bold=False, color=INK):
    c.setFont("JP-Bold" if bold else "JP", size)
    c.setFillColor(color)


def wrap_lines(text, font_name, size, max_width):
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and pdfmetrics.stringWidth(candidate, font_name, size) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines


def draw_text(c, text, x, y, max_width, size=10, leading=None, bold=False, color=INK):
    font = "JP-Bold" if bold else "JP"
    leading = leading or size * 1.55
    set_font(c, size, bold, color)
    for line in wrap_lines(text, font, size, max_width):
        c.drawString(x, y, line)
        y -= leading
    return y


def rounded_box(c, x, y, w, h, fill=white, stroke=LINE, radius=10, width=1):
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(width)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def pill(c, text, x, y, fill, text_color, width=None, height=24, size=9):
    if width is None:
        width = pdfmetrics.stringWidth(text, "JP-Bold", size) + 22
    c.setFillColor(fill)
    c.setStrokeColor(fill)
    c.roundRect(x, y, width, height, height / 2, fill=1, stroke=0)
    set_font(c, size, True, text_color)
    text_w = pdfmetrics.stringWidth(text, "JP-Bold", size)
    c.drawString(x + (width - text_w) / 2, y + (height - size) / 2 + 1.5, text)
    return width


def page_footer(c, page_num):
    c.setStrokeColor(LINE)
    c.line(MARGIN, 29, PAGE_W - MARGIN, 29)
    set_font(c, 7.5, False, MUTED)
    c.drawString(MARGIN, 16, "Prompt Memo 利用マニュアル")
    c.drawRightString(PAGE_W - MARGIN, 16, f"{page_num} / 4")


def page_heading(c, page_num, title, subtitle):
    c.setFillColor(CANVAS)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    set_font(c, 9, True, GREEN)
    c.drawString(MARGIN, PAGE_H - 50, f"PROMPT MEMO  /  {page_num:02d}")
    set_font(c, 24, True, INK)
    c.drawString(MARGIN, PAGE_H - 82, title)
    draw_text(c, subtitle, MARGIN, PAGE_H - 104, PAGE_W - MARGIN * 2, 9.5, 15, False, MUTED)
    page_footer(c, page_num)


def draw_number(c, number, x, y, color=GREEN):
    c.setFillColor(color)
    c.circle(x, y, 14, fill=1, stroke=0)
    set_font(c, 10, True, white)
    value = str(number)
    c.drawCentredString(x, y - 3.5, value)


def page_cover(c):
    c.setFillColor(CANVAS)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(GREEN_DARK)
    c.rect(0, PAGE_H - 242, PAGE_W, 242, fill=1, stroke=0)

    set_font(c, 10, True, HexColor("#BFE4D4"))
    c.drawString(MARGIN, PAGE_H - 62, "EDGE EXTENSION  /  USER GUIDE")
    set_font(c, 34, True, white)
    c.drawString(MARGIN, PAGE_H - 111, "Prompt Memo")
    set_font(c, 15, False, white)
    c.drawString(MARGIN, PAGE_H - 143, "よく使うAIプロンプトを、すぐ呼び出す。")
    draw_text(
        c,
        "保存・検索・貼り付けをひとつにまとめた、Microsoft Edge用のシンプルな拡張機能です。",
        MARGIN,
        PAGE_H - 174,
        340,
        9.5,
        16,
        False,
        HexColor("#D8EEE5"),
    )
    c.drawImage(ImageReader(str(ICON)), PAGE_W - 190, PAGE_H - 203, 138, 138, mask="auto")

    set_font(c, 12, True, INK)
    c.drawString(MARGIN, 555, "できること")
    feature_y = 503
    features = [
        ("01", "ためる", "タイトル・本文・タグを付けて保存"),
        ("02", "見つける", "お気に入りと検索ですばやく絞り込み"),
        ("03", "使う", "入力欄へ直接貼り付け、またはコピー"),
    ]
    card_w = (PAGE_W - MARGIN * 2 - 20) / 3
    for i, (num, title, desc) in enumerate(features):
        x = MARGIN + i * (card_w + 10)
        rounded_box(c, x, feature_y - 92, card_w, 92, white, LINE, 12)
        pill(c, num, x + 12, feature_y - 30, GREEN_SOFT, GREEN, width=34, height=20, size=8)
        set_font(c, 12, True, INK)
        c.drawString(x + 12, feature_y - 51, title)
        draw_text(c, desc, x + 12, feature_y - 70, card_w - 24, 8, 12, False, MUTED)

    rounded_box(c, MARGIN, 274, PAGE_W - MARGIN * 2, 108, GREEN_SOFT, HexColor("#B9DCCB"), 14)
    set_font(c, 12, True, GREEN_DARK)
    c.drawString(MARGIN + 18, 352, "最短3ステップ")
    steps = ["Edgeへ追加", "プロンプトを登録", "AIの入力欄へ貼り付け"]
    for i, text in enumerate(steps):
        x = MARGIN + 28 + i * 165
        draw_number(c, i + 1, x, 317)
        set_font(c, 9, True, INK)
        c.drawString(x + 23, 313, text)
        if i < 2:
            c.setStrokeColor(HexColor("#8BBEAA"))
            c.setLineWidth(1.5)
            c.line(x + 125, 317, x + 148, 317)
            c.line(x + 143, 321, x + 148, 317)
            c.line(x + 143, 313, x + 148, 317)

    set_font(c, 9, True, MUTED)
    c.drawString(MARGIN, 224, "対象")
    set_font(c, 9.5, False, INK)
    c.drawString(MARGIN + 48, 224, "Microsoft Edge（Chromium版）")
    set_font(c, 9, True, MUTED)
    c.drawString(MARGIN, 197, "保存先")
    set_font(c, 9.5, False, INK)
    c.drawString(MARGIN + 48, 197, "通常データはEdge内。必要に応じてJSONへバックアップできます。")
    set_font(c, 8, False, MUTED)
    c.drawString(MARGIN, 73, "Version 1.0  |  2026年7月")
    page_footer(c, 1)


def install_step(c, n, y, title, text, badge=None):
    rounded_box(c, MARGIN, y - 88, PAGE_W - MARGIN * 2, 82, white, LINE, 12)
    draw_number(c, n, MARGIN + 27, y - 32)
    set_font(c, 12, True, INK)
    c.drawString(MARGIN + 53, y - 25, title)
    draw_text(c, text, MARGIN + 53, y - 46, PAGE_W - MARGIN * 2 - 75, 8.7, 13, False, MUTED)
    if badge:
        pill(c, badge, PAGE_W - MARGIN - 115, y - 37, GREEN_SOFT, GREEN, width=100, height=22, size=8)


def page_install(c):
    page_heading(c, 2, "Edgeへ追加する", "受け取ったPromptMemoフォルダーを、Edgeの拡張機能として読み込みます。")
    install_step(
        c,
        1,
        700,
        "フォルダーを準備",
        "ZIPで受け取った場合は、先に右クリックして「すべて展開」します。ZIPのままでは読み込めません。",
        "最初の1回だけ",
    )
    install_step(
        c,
        2,
        603,
        "拡張機能ページを開く",
        "Edgeのアドレスバーへ edge://extensions/ と入力し、Enterキーを押します。",
    )
    install_step(
        c,
        3,
        506,
        "「開発者モード」をオン",
        "拡張機能ページのスイッチをオンにすると、「展開して読み込み」が表示されます。",
    )
    install_step(
        c,
        4,
        409,
        "「展開して読み込み」を選択",
        "展開したPromptMemoフォルダーを選びます。manifest.jsonが入っているフォルダーが正解です。",
    )
    install_step(
        c,
        5,
        312,
        "ツールバーへ固定",
        "Edge右上の拡張機能（パズル型）を開き、Prompt Memoをツールバーへ表示します。",
    )

    rounded_box(c, MARGIN, 92, PAGE_W - MARGIN * 2, 98, GREEN_SOFT, HexColor("#B9DCCB"), 12)
    set_font(c, 10.5, True, GREEN_DARK)
    c.drawString(MARGIN + 15, 164, "更新版を受け取ったとき")
    draw_text(
        c,
        "フォルダーのファイルを更新したあと、edge://extensions/ のPrompt Memo欄で「再読み込み」を押します。保存済みのプロンプトは通常そのまま残ります。",
        MARGIN + 15,
        143,
        PAGE_W - MARGIN * 2 - 30,
        8.8,
        14,
        False,
        INK,
    )


def draw_mini_button(c, text, x, y, w, fill, text_color=white, stroke=None):
    stroke = stroke or fill
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.roundRect(x, y, w, 19, 6, fill=1, stroke=1)
    set_font(c, 6.8, True, text_color)
    c.drawCentredString(x + w / 2, y + 6, text)


def draw_popup_mock(c, x, y, w, h):
    c.saveState()
    c.setShadow = lambda *args, **kwargs: None
    rounded_box(c, x, y, w, h, CANVAS, LINE, 12)
    c.setFillColor(white)
    c.roundRect(x, y + h - 62, w, 62, 12, fill=1, stroke=0)
    c.rect(x, y + h - 62, w, 10, fill=1, stroke=0)
    c.drawImage(ImageReader(str(ICON)), x + 14, y + h - 49, 31, 31, mask="auto")
    set_font(c, 6.3, True, GREEN)
    c.drawString(x + 52, y + h - 25, "PROMPT LIBRARY")
    set_font(c, 13, True, INK)
    c.drawString(x + 52, y + h - 43, "Prompt Memo")
    c.setFillColor(GREEN)
    c.roundRect(x + w - 43, y + h - 45, 28, 28, 8, fill=1, stroke=0)
    set_font(c, 17, False, white)
    c.drawCentredString(x + w - 29, y + h - 39, "+")
    c.setFillColor(white)
    c.setStrokeColor(LINE)
    c.roundRect(x + w - 99, y + h - 43, 50, 24, 7, fill=1, stroke=1)
    set_font(c, 6.2, True, MUTED)
    c.drawCentredString(x + w - 74, y + h - 35, "確認設定")

    rounded_box(c, x + 12, y + h - 96, w - 24, 25, white, LINE, 8)
    c.setStrokeColor(MUTED)
    c.setLineWidth(0.8)
    c.circle(x + 22, y + h - 83, 3, fill=0, stroke=1)
    c.line(x + 24.2, y + h - 85.2, x + 27, y + h - 88, )
    set_font(c, 7.3, False, MUTED)
    c.drawString(x + 31, y + h - 87, "タイトル・本文・タグを検索")
    pill(c, "★ お気に入り", x + 12, y + h - 128, GREEN_SOFT, GREEN, width=83, height=20, size=6.8)
    pill(c, "その他", x + 101, y + h - 128, white, MUTED, width=53, height=20, size=6.8)

    card_y = y + h - 191
    samples = [
        ("議事録を要約", "長い議事録から決定事項と担当を整理", True),
        ("メールを整える", "丁寧で簡潔な文章に書き換える", True),
        ("アイデアを広げる", "異なる観点から案を10個出す", False),
    ]
    for idx, (title, body, fav) in enumerate(samples):
        cy = card_y - idx * 63
        rounded_box(c, x + 12, cy, w - 24, 55, white, LINE, 8)
        set_font(c, 7.5, True, INK)
        c.drawString(x + 20, cy + 38, title)
        set_font(c, 7.2, False, GOLD if fav else MUTED)
        c.drawString(x + w - 89, cy + 38, "★" if fav else "☆")
        set_font(c, 6.5, False, MUTED)
        c.drawString(x + 20, cy + 24, body[:20])
        draw_mini_button(c, "貼り付け", x + 20, cy + 4, 52, GREEN)
        draw_mini_button(c, "コピー", x + 76, cy + 4, 43, BLUE)
        draw_mini_button(c, "1件保存", x + 123, cy + 4, 52, ORANGE)

    footer_y = y + 11
    c.setStrokeColor(LINE)
    c.line(x + 12, footer_y + 57, x + w - 12, footer_y + 57)
    set_font(c, 7.5, True, INK)
    c.drawString(x + 12, footer_y + 41, "全件バックアップ")
    draw_mini_button(c, "全件を書き出す", x + 12, footer_y + 12, 102, GREEN)
    draw_mini_button(c, "復元（1件または全件）", x + 119, footer_y + 12, w - 131, white, INK, LINE)
    c.restoreState()


def info_card(c, x, y, w, title, text, color=GREEN, number=None, h=76):
    rounded_box(c, x, y - h, w, h, white, LINE, 10)
    if number is not None:
        draw_number(c, number, x + 19, y - 22, color)
        title_x = x + 41
    else:
        title_x = x + 14
    set_font(c, 10, True, INK)
    c.drawString(title_x, y - 19, title)
    draw_text(c, text, x + 14, y - 38, w - 28, 8, 12.5, False, MUTED)


def page_use(c):
    page_heading(c, 3, "基本の使い方", "普段使う操作は、追加・検索・貼り付けの3つです。")
    mock_x, mock_y, mock_w, mock_h = MARGIN, 82, 254, 624
    draw_popup_mock(c, mock_x, mock_y, mock_w, mock_h)

    right_x = 319
    right_w = PAGE_W - MARGIN - right_x
    info_card(c, right_x, 706, right_w, "追加・編集・確認設定", "＋で追加、「編集」で内容を変更。「確認設定」で削除と全件復元の確認を個別に戻せます。", number=1, h=84)
    info_card(c, right_x, 611, right_w, "お気に入り／その他", "起動時はお気に入りを表示。「その他」には、お気に入り以外だけが表示されます。", number=2, h=84)
    info_card(c, right_x, 516, right_w, "検索", "タイトル・本文・タグをまとめて検索します。入力するたびに一覧が絞り込まれます。", number=3, h=84)

    rounded_box(c, right_x, 297, right_w, 124, white, LINE, 10)
    set_font(c, 10, True, INK)
    c.drawString(right_x + 14, 399, "3つの操作ボタン")
    rows = [
        (GREEN, "貼り付け", "選択中の入力欄へ直接挿入"),
        (BLUE, "コピー", "クリップボードへコピー"),
        (ORANGE, "1件保存", "そのプロンプトだけJSON保存"),
    ]
    for i, (color, label, desc) in enumerate(rows):
        ry = 369 - i * 30
        draw_mini_button(c, label, right_x + 14, ry, 54, color)
        set_font(c, 7.6, False, MUTED)
        c.drawString(right_x + 77, ry + 6, desc)

    rounded_box(c, right_x, 187, right_w, 94, ORANGE_SOFT, HexColor("#F0C89E"), 10)
    set_font(c, 9, True, ORANGE)
    c.drawString(right_x + 14, 258, "貼り付けのコツ")
    draw_text(
        c,
        "先にAIサイトの入力欄をクリックしてカーソルを置き、そのあとPrompt Memoを開きます。入力欄が見つからない場合は、自動的にコピーされます。",
        right_x + 14,
        238,
        right_w - 28,
        7.8,
        12,
        False,
        INK,
    )

    rounded_box(c, right_x, 82, right_w, 89, BLUE_SOFT, HexColor("#BCD3EC"), 10)
    set_font(c, 9, True, BLUE)
    c.drawString(right_x + 14, 149, "タイトルの重複")
    draw_text(
        c,
        "新規追加では、同じタイトルを登録できません。既存データや復元したデータの重複はそのまま利用できます。",
        right_x + 14,
        129,
        right_w - 28,
        7.8,
        12,
        False,
        INK,
    )


def backup_box(c, x, y, w, h, title, path, description, color):
    rounded_box(c, x, y, w, h, white, LINE, 12)
    c.setFillColor(color)
    c.roundRect(x + 13, y + h - 37, 34, 24, 7, fill=1, stroke=0)
    set_font(c, 12, True, white)
    c.drawCentredString(x + 30, y + h - 31, "JSON")
    set_font(c, 11, True, INK)
    c.drawString(x + 57, y + h - 29, title)
    rounded_box(c, x + 13, y + h - 72, w - 26, 23, CANVAS, LINE, 5)
    set_font(c, 7.2, False, GREEN_DARK)
    c.drawString(x + 21, y + h - 64, path)
    draw_text(c, description, x + 14, y + h - 92, w - 28, 8, 12.5, False, MUTED)


def trouble_row(c, y, symptom, answer):
    c.setStrokeColor(LINE)
    c.line(MARGIN, y - 8, PAGE_W - MARGIN, y - 8)
    set_font(c, 8.5, True, INK)
    c.drawString(MARGIN + 8, y + 8, symptom)
    draw_text(c, answer, MARGIN + 165, y + 8, PAGE_W - MARGIN * 2 - 175, 8, 12, False, MUTED)


def page_backup(c):
    page_heading(c, 4, "バックアップ・復元", "大切なプロンプトはJSONファイルとして保管できます。ファイルの用途を区別して使います。")
    gap = 12
    box_w = (PAGE_W - MARGIN * 2 - gap) / 2
    backup_box(
        c,
        MARGIN,
        512,
        box_w,
        170,
        "全件バックアップ",
        r"ダウンロード\PromptMemo_backup\prompts.json",
        "画面下の「全件を書き出す」で作成します。すべてのプロンプトを1つのファイルに保存します。",
        GREEN,
    )
    backup_box(
        c,
        MARGIN + box_w + gap,
        512,
        box_w,
        170,
        "個別プロンプト",
        r"PromptMemo_backup\個別プロンプト\タイトル.json",
        "各カードの「1件保存」で作成します。選択したプロンプトだけを保存します。",
        ORANGE,
    )

    set_font(c, 12, True, INK)
    c.drawString(MARGIN, 480, "復元したときの動き")
    rounded_box(c, MARGIN, 365, box_w, 96, GREEN_SOFT, HexColor("#B9DCCB"), 10)
    set_font(c, 10, True, GREEN_DARK)
    c.drawString(MARGIN + 14, 437, "全件バックアップを選択")
    draw_text(c, "確認後、現在の一覧をバックアップ内の全件で置き換えます。", MARGIN + 14, 415, box_w - 28, 8.5, 14, False, INK)
    rounded_box(c, MARGIN + box_w + gap, 365, box_w, 96, ORANGE_SOFT, HexColor("#F0C89E"), 10)
    set_font(c, 10, True, ORANGE)
    c.drawString(MARGIN + box_w + gap + 14, 437, "個別ファイルを選択")
    draw_text(c, "現在の一覧を残したまま、選択した1件を追加します。", MARGIN + box_w + gap + 14, 415, box_w - 28, 8.5, 14, False, INK)

    rounded_box(c, MARGIN, 316, PAGE_W - MARGIN * 2, 34, BLUE_SOFT, HexColor("#BCD3EC"), 8)
    set_font(c, 8.3, True, BLUE)
    c.drawString(MARGIN + 13, 328, "ポイント：プロンプトの追加・編集・削除だけでは prompts.json は上書きされません。")

    set_font(c, 12, True, INK)
    c.drawString(MARGIN, 278, "困ったとき")
    trouble_row(c, 240, "入力欄へ貼り付かない", "入力欄を先にクリックします。難しい場合は「コピー」→ Ctrl+V を使います。")
    trouble_row(c, 196, "確認画面を元に戻したい", "ヘッダーの「確認設定」を開き、戻したい確認項目を個別にオンにします。")
    trouble_row(c, 152, "保存先を確認したい", r"Edgeのダウンロード一覧、またはダウンロード\PromptMemo_backup を確認します。")
    trouble_row(c, 108, "データを安全に残したい", "定期的に「全件を書き出す」を押し、prompts.jsonを別の場所にもコピーします。")


def build():
    register_fonts()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT_FILE), pagesize=A4, pageCompression=1)
    c.setTitle("Prompt Memo 利用マニュアル")
    c.setAuthor("Prompt Memo")
    c.setSubject("Microsoft Edge拡張機能 Prompt Memo の設定方法と操作方法")

    page_cover(c)
    c.showPage()
    page_install(c)
    c.showPage()
    page_use(c)
    c.showPage()
    page_backup(c)
    c.save()
    print(OUTPUT_FILE)


if __name__ == "__main__":
    build()
