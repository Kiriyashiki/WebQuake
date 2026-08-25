import re
import pandas as pd
import pykakasi

kks = pykakasi.kakasi()
FULL_TO_HALF = str.maketrans("０１２３４５６７８９", "0123456789")

PREFECTURES_AND_CITIES = [
    ("北海道", "ほっかいどう", "Hokkaido"), ("青森", "あおもり", "Aomori"),
    ("岩手", "いわて", "Iwate"), ("宮城", "みやぎ", "Miyagi"),
    ("秋田", "あきた", "Akita"), ("山形", "やまがた", "Yamagata"),
    ("福島", "ふくしま", "Fukushima"), ("茨城", "いばらき", "Ibaraki"),
    ("栃木", "とちぎ", "Tochigi"), ("群馬", "ぐんま", "Gunma"),
    ("埼玉", "さいたま", "Saitama"), ("千葉", "ちば", "Chiba"),
    ("東京", "とうきょう", "Tokyo"), ("神奈川", "かながわ", "Kanagawa"),
    ("新潟", "にいがた", "Niigata"), ("富山", "とやま", "Toyama"),
    ("石川", "いしかわ", "Ishikawa"), ("福井", "ふくい", "Fukui"),
    ("山梨", "やまなし", "Yamanashi"), ("長野", "ながの", "Nagano"),
    ("岐阜", "ぎふ", "Gifu"), ("静岡", "しずおか", "Shizuoka"),
    ("愛知", "あいち", "Aichi"), ("三重", "みえ", "Mie"),
    ("滋賀", "しが", "Shiga"), ("京都", "きょうと", "Kyoto"),
    ("大阪", "おおさか", "Osaka"), ("兵庫", "ひょうご", "Hyogo"),
    ("奈良", "なら", "Nara"), ("和歌山", "わかやま", "Wakayama"),
    ("鳥取", "とっとり", "Tottori"), ("島根", "しまね", "Shimane"),
    ("岡山", "おかやま", "Okayama"), ("広島", "ひろしま", "Hiroshima"),
    ("山口", "やまぐち", "Yamaguchi"), ("徳島", "とくしま", "Tokushima"),
    ("香川", "かがわ", "Kagawa"), ("愛媛", "えひめ", "Ehime"),
    ("高知", "こうち", "Kochi"), ("福岡", "ふくおか", "Fukuoka"),
    ("佐賀", "さが", "Saga"), ("長崎", "ながさき", "Nagasaki"),
    ("熊本", "くまもと", "Kumamoto"), ("大分", "おおいた", "Oita"),
    ("宮崎", "みやざき", "Miyazaki"), ("鹿児島", "かごしま", "Kagoshima"),
    ("沖縄", "おきなわ", "Okinawa"),
    ("札幌", "さっぽろ", "Sapporo"), ("仙台", "せんだい", "Sendai"),
    ("横浜", "よこはま", "Yokohama"), ("名古屋", "なごや", "Nagoya"),
    ("神戸", "こうべ", "Kobe"), ("北九州", "きたきゅうしゅう", "Kitakyushu"),
    ("浜松", "はままつ", "Hamamatsu")
]

# (List of Kanji/Katakana variations, List of Kana variants, English label)
# Longer & compound facilities MUST precede shorter ones
ADMIN_SUFFIXES = [
    (["老人福祉センター", "老人福祉センタ"], ["ろうじんふくしせんたー", "ろうじんふくしせんた"], "Senior Welfare Center"),
    (["総合センター", "総合センタ"], ["そうごうせんたー", "そうごうせんた"], "General Center"),
    (["健康センター", "健康センタ"], ["けんこうせんたー", "けんこうせんた"], "Health Center"),
    (["福祉センター", "福祉センタ"], ["ふくしせんたー", "ふくしせんた"], "Welfare Center"),
    (["保健センター", "保健センタ"], ["ほけんせんたー", "ほけんせんた"], "Health Center"),
    (["文化センター", "文化センタ"], ["ぶんかせんたー", "ぶんかせんた"], "Cultural Center"),
    (["スポーツセンター", "スポーツセンタ"], ["すぽーつせんたー", "すぽーつせんた"], "Sports Center"),
    (["センター", "センタ"], ["せんたー", "せんた"], "Center"),
    (["国際空港"], ["こくさいくうこう"], "International Airport"),
    (["青年会館"], ["せいねんかいかん"], "Youth Center"),
    (["運動公園"], ["うんどうこうえん"], "Sports Park"),
    (["高等学校"], ["こうとうがっこう"], "High School"),
    (["出張所"], ["しゅっちょうしょ"], "Branch Office"),
    (["市役所"], ["しやくしょ"], "City Hall"),
    (["中学校"], ["ちゅうがっこう"], "Middle School"),
    (["小学校"], ["しょうがっこう"], "Elementary School"),
    (["保育園"], ["ほいくえん"], "Preschool"),
    (["公民館"], ["こうみんかん"], "Community Center"),
    (["役場"], ["やくば"], "Town Office"),
    (["東庁舎"], ["ひがしちょうしゃ"], "East Office"),
    (["西庁舎"], ["にしちょうしゃ"], "West Office"),
    (["南庁舎"], ["みなみちょうしゃ"], "South Office"),
    (["北庁舎"], ["きたちょうしゃ"], "North Office"),
    (["本庁舎"], ["ほんちょうしゃ"], "Main Office"),
    (["庁舎"], ["ちょうしゃ"], "Government Office"),
    (["空港"], ["くうこう"], "Airport"),
    (["温泉"], ["おんせん"], "Onsen"),
    (["公園"], ["こうえん"], "Park"),
    (["郵便局"], ["ゆうびんきょく"], "Post Office"),
    (["消防本部"], ["しょうぼうほんぶ"], "Fire Department"),
    (["消防分団"], ["しょうぼうぶんだん"], "Fire Brigade"),
    (["消防署"], ["しょうぼうしょ"], "Fire Station"),
    (["市"], ["し"], "City"),
    (["区"], ["く"], "Ward"),
    (["町"], ["ちょう", "まち"], "Town"),
    (["村"], ["むら", "そん"], "Village"),
]

INTEGRAL_DIRECTION_NAMES = {
    "湖南", "海南", "湘南", "城南", "県南", "県北", "県東", "県西",
    "道南", "道北", "道東", "道央", "甲府", "防府"
}

# Specific merged area names or neighborhood proper names containing '町' or '村'
PROTECTED_STEMS = {
    "信州新町": ("しんしゅうしんまち", "Shinshushinmachi"),
    "新町": ("しんまち", "Shinmachi"),
    "本町": ("ほんちょう", "Honcho"),
    "中町": ("なかまち", "Nakamachi"),
    "元町": ("もとまち", "Motomachi"),
    "栄町": ("さかえまち", "Sakaemachi"),
}

def normalize_text(text: str) -> str:
    """Normalize digits, kana dashes, and prolonged sound marks."""
    if not isinstance(text, str):
        return ""
    text = text.strip().translate(FULL_TO_HALF)
    text = re.sub(r"[\u2010-\u2015\u2212\uff0d\-]", "ー", text)
    return text

def kana_to_hepburn(kana_str: str) -> str:
    """Converts a kana string to clean, capitalized Hepburn Romaji."""
    if not kana_str:
        return ""
    res = kks.convert(kana_str)
    romaji = "".join([item["hepburn"] for item in res if item["hepburn"]])
    romaji = re.sub(r'ou(?=[bcdfghjklmnpqrstvwxyz]|$)', 'o', romaji)
    romaji = re.sub(r'uu(?=[bcdfghjklmnpqrstvwxyz]|$)', 'u', romaji)
    romaji = re.sub(r'oo(?=[bcdfghjklmnpqrstvwxyz]|$)', 'o', romaji)
    return romaji.capitalize()

def format_stem(stem_ja: str, stem_kana: str) -> str:
    if stem_ja in INTEGRAL_DIRECTION_NAMES:
        return kana_to_hepburn(stem_kana)

    if len(stem_ja) >= 3:
        dir_match = re.match(r"^(.+?)(北|南|東|西|中央)$", stem_ja)
        if dir_match:
            base_ja, dir_ja = dir_match.groups()
            dir_en = {"北": "Kita", "南": "Minami", "東": "Higashi", "西": "Nishi", "中央": "Chuo"}[dir_ja]
            dir_kana_len = len("".join([x['hira'] for x in kks.convert(dir_ja)]))
            base_kana = stem_kana[:-dir_kana_len] if len(stem_kana) > dir_kana_len else stem_kana
            return f"{kana_to_hepburn(base_kana)} {dir_en}"

    return kana_to_hepburn(stem_kana)

def parse_street_or_number(ja_part: str, kana_part: str) -> str:
    ja_clean = ja_part.translate(FULL_TO_HALF)

    m_sen = re.search(r"第?(\d+)線", ja_clean)
    if m_sen:
        num = m_sen.group(1)
        suffix = "th" if 11 <= int(num) % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(int(num) % 10, "th")
        return f"{num}{suffix} Line"

    m_jo = re.search(r"([北南東西])?(\d+)条", ja_clean)
    if m_jo:
        dir_char, num = m_jo.group(1), m_jo.group(2)
        dir_en = {"北": "Kita", "南": "Minami", "東": "Higashi", "西": "Nishi"}.get(dir_char, "")
        return f"{dir_en} {num}-jo".strip()

    return kana_to_hepburn(kana_part)

def translate_row(row) -> str:
    code = str(row["code"]).strip() if pd.notna(row.get("code")) else ""
    nameja = str(row["nameja"]).strip() if pd.notna(row.get("nameja")) else ""
    kana = str(row["kana"]).strip() if pd.notna(row.get("kana")) else ""

    if not code or not kana or not nameja:
        return ""

    nameja = normalize_text(nameja)
    kana = normalize_text(kana)
    tokens = []

    # 1. Match and extract Prefecture / Base City Prefix
    for p_ja, p_ka, p_en in PREFECTURES_AND_CITIES:
        if nameja.startswith(p_ja) and not (nameja.startswith(f"{p_ja}市") or nameja.startswith(f"{p_ja}区")):
            if kana.startswith(p_ka):
                tokens.append(p_en)
                nameja = nameja[len(p_ja):]
                kana = kana[len(p_ka):]
                break

    # 2. Step through administrative entities left-to-right
    while nameja:
        matched_protected = False
        for prot_ja, (prot_ka, prot_en) in PROTECTED_STEMS.items():
            if nameja.startswith(prot_ja) and kana.startswith(prot_ka):
                tokens.append(prot_en)
                nameja = nameja[len(prot_ja):]
                kana = kana[len(prot_ka):]
                matched_protected = True
                break
        if matched_protected:
            continue

        earliest_pos = len(nameja) + 1
        best_match = None

        for s_ja_list, s_ka_list, s_en in ADMIN_SUFFIXES:
            for s_ja in s_ja_list:
                # Start search at index 1 for single-kanji units (市, 区, 町, 村)
                # so leading characters in names like 市原 or 区界 don't block finding the suffix
                search_start_ja = 1 if len(s_ja) == 1 else 0
                pos = nameja.find(s_ja, search_start_ja)

                if pos == -1:
                    continue

                if pos < earliest_pos:
                    earliest_pos = pos
                    best_match = (s_ja, s_ka_list, s_en, pos)

        if best_match:
            s_ja, s_ka_list, s_en, pos = best_match
            stem_ja = nameja[:pos]
            nameja = nameja[pos + len(s_ja):]

            expected_stem_kana = "".join([x['hira'] for x in kks.convert(stem_ja)])
            expected_stem_len = len(expected_stem_kana)

            # Check if kana starts with expected_stem_kana + suffix_kana directly
            matched_exact = False
            for s_ka in s_ka_list:
                if kana.startswith(expected_stem_kana + s_ka):
                    stem_kana = expected_stem_kana
                    kana = kana[expected_stem_len + len(s_ka):]
                    matched_exact = True
                    break

            if not matched_exact:
                search_start_ka = max(0, expected_stem_len - 1)
                k_cut = -1
                matched_ka = ""
                for s_ka in s_ka_list:
                    k_idx = kana.find(s_ka, search_start_ka)
                    if k_idx != -1:
                        if k_cut == -1 or k_idx < k_cut:
                            k_cut = k_idx
                            matched_ka = s_ka

                if k_cut == -1:
                    for s_ka in s_ka_list:
                        k_idx = kana.find(s_ka)
                        if k_idx != -1:
                            if k_cut == -1 or k_idx < k_cut:
                                k_cut = k_idx
                                matched_ka = s_ka

                if k_cut != -1:
                    stem_kana = kana[:k_cut]
                    kana = kana[k_cut + len(matched_ka):]
                else:
                    stem_kana = kana
                    kana = ""

            stem_en = format_stem(stem_ja, stem_kana)
            if stem_en:
                tokens.append(f"{stem_en} {s_en}")
            else:
                tokens.append(s_en)
        else:
            rest_en = parse_street_or_number(nameja, kana)
            if rest_en:
                tokens.append(rest_en)
            break

    return " ".join(tokens)

# ================= Execution =================
df = pd.read_csv("stations.csv", sep=";", dtype=str, keep_default_na=False)

# 1. Translate
df["nameen"] = df.apply(translate_row, axis=1)

# 2. Flag missing/incomplete rows to sort them to the bottom
df["_is_incomplete"] = (
    (df["code"].str.strip() == "") |
    (df["kana"].str.strip() == "") |
    (df["nameja"].str.strip() == "")
)

# Sort: valid rows on top (False), incomplete rows at the bottom (True)
df = df.sort_values(by="_is_incomplete", ascending=True).drop(columns=["_is_incomplete"])

# 3. Export clean CSV
df.to_csv("output.csv", sep=";", index=False, encoding="utf-8-sig")
