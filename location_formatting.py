import os
import re
import time
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client
from groq import Groq, RateLimitError
from rapidfuzz import process, fuzz

load_dotenv()

# ==================================================
# CONFIGURATION
# ==================================================

JOBS_TABLE = "jobs"
TARGET_TABLE = "jobs_uploadable_wp"

TEST_LIMIT = 100  # <-- set to None to run on full table

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

GROQ_API_KEYS = [
    os.getenv("API_KEY1"),
    os.getenv("API_KEY2"),
    os.getenv("API_KEY3"),
    os.getenv("API_KEY4"),
    os.getenv("API_KEY5"),
    os.getenv("API_KEY6"),
]
GROQ_API_KEYS = [k for k in GROQ_API_KEYS if k]

BATCH_SIZE = 500
UPDATE_BATCH_SIZE = 200  # how many rows per upsert call back to supabase

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

current_key_index = 0

# ==================================================
# STATIC INDIA CITY -> STATE LOOKUP (fast path, no API calls)
# ==================================================

CITY_STATE_MAP = {
    # Karnataka
    "bangalore": ("Bangalore", "Karnataka"), "bengaluru": ("Bangalore", "Karnataka"),
    "mysore": ("Mysore", "Karnataka"), "mysuru": ("Mysore", "Karnataka"),
    "hubli": ("Hubli", "Karnataka"), "mangalore": ("Mangalore", "Karnataka"),
    "belgaum": ("Belgaum", "Karnataka"), "gadag": ("Gadag", "Karnataka"),
    "koppal": ("Koppal", "Karnataka"), "honnavar": ("Honnavar", "Karnataka"),
    "vijayapura": ("Vijayapura", "Karnataka"), "dharwad": ("Dharwad", "Karnataka"),
    "honwad": ("Honwad", "Karnataka"),

    # Maharashtra
    "mumbai": ("Mumbai", "Maharashtra"), "navi mumbai": ("Navi Mumbai", "Maharashtra"),
    "pune": ("Pune", "Maharashtra"), "nagpur": ("Nagpur", "Maharashtra"),
    "nashik": ("Nashik", "Maharashtra"), "thane": ("Thane", "Maharashtra"),
    "aurangabad": ("Aurangabad", "Maharashtra"), "solapur": ("Solapur", "Maharashtra"),
    "kolhapur": ("Kolhapur", "Maharashtra"),

    # Delhi/NCR
    "delhi": ("Delhi", "Delhi"), "new delhi": ("New Delhi", "Delhi"),
    "noida": ("Noida", "Uttar Pradesh"), "greater noida": ("Greater Noida", "Uttar Pradesh"),
    "gurugram": ("Gurugram", "Haryana"), "gurgaon": ("Gurugram", "Haryana"),
    "faridabad": ("Faridabad", "Haryana"), "ghaziabad": ("Ghaziabad", "Uttar Pradesh"),

    # Tamil Nadu
    "chennai": ("Chennai", "Tamil Nadu"), "coimbatore": ("Coimbatore", "Tamil Nadu"),
    "madurai": ("Madurai", "Tamil Nadu"), "dindigul": ("Dindigul", "Tamil Nadu"),

    # Telangana / AP
    "hyderabad": ("Hyderabad", "Telangana"), "secunderabad": ("Secunderabad", "Telangana"),
    "maheshwaram": ("Maheshwaram", "Telangana"),
    "visakhapatnam": ("Visakhapatnam", "Andhra Pradesh"), "vizag": ("Visakhapatnam", "Andhra Pradesh"),

    # West Bengal
    "kolkata": ("Kolkata", "West Bengal"), "barrackpore": ("Barrackpore", "West Bengal"),
    "bardhaman": ("Bardhaman", "West Bengal"), "burdwan": ("Bardhaman", "West Bengal"),
    "siliguri": ("Siliguri", "West Bengal"), "chinsurah": ("Chinsurah", "West Bengal"),
    "naihati": ("Naihati", "West Bengal"), "madhyamgram": ("Madhyamgram", "West Bengal"),
    "saltlake": ("Kolkata", "West Bengal"), "salt lake": ("Kolkata", "West Bengal"),

    # Rajasthan
    "jaipur": ("Jaipur", "Rajasthan"), "bagru": ("Bagru", "Rajasthan"),
    "jodhpur": ("Jodhpur", "Rajasthan"), "udaipur": ("Udaipur", "Rajasthan"),
    "kota": ("Kota", "Rajasthan"),

    # Gujarat
    "ahmedabad": ("Ahmedabad", "Gujarat"), "gandhinagar": ("Gandhinagar", "Gujarat"),
    "surat": ("Surat", "Gujarat"), "vadodara": ("Vadodara", "Gujarat"),

    # Kerala
    "cochin": ("Kochi", "Kerala"), "kochi": ("Kochi", "Kerala"),
    "thiruvananthapuram": ("Thiruvananthapuram", "Kerala"), "trivandrum": ("Thiruvananthapuram", "Kerala"),
    "kozhikode": ("Kozhikode", "Kerala"), "calicut": ("Kozhikode", "Kerala"),

    # Madhya Pradesh
    "bhopal": ("Bhopal", "Madhya Pradesh"), "indore": ("Indore", "Madhya Pradesh"),
    "gwalior": ("Gwalior", "Madhya Pradesh"),

    # Uttarakhand
    "roorkee": ("Roorkee", "Uttarakhand"), "dehradun": ("Dehradun", "Uttarakhand"),
    "haridwar": ("Haridwar", "Uttarakhand"),

    # Bihar
    "patna": ("Patna", "Bihar"), "madhubani": ("Madhubani", "Bihar"),

    # West Bengal (Dinhata etc - Cooch Behar dist)
    "dinhata": ("Dinhata", "West Bengal"),

    # Goa
    "goa": ("Goa", "Goa"), "mormugao": ("Mormugao", "Goa"), "panaji": ("Panaji", "Goa"),

    # Punjab / Haryana
    "chandigarh": ("Chandigarh", "Chandigarh"), "ludhiana": ("Ludhiana", "Punjab"),
    "amritsar": ("Amritsar", "Punjab"),

    # UP other
    "lucknow": ("Lucknow", "Uttar Pradesh"), "kanpur": ("Kanpur", "Uttar Pradesh"),
    "agra": ("Agra", "Uttar Pradesh"),
}

INDIAN_STATES = {
    "karnataka", "maharashtra", "tamil nadu", "telangana", "andhra pradesh",
    "west bengal", "rajasthan", "gujarat", "kerala", "madhya pradesh",
    "uttarakhand", "bihar", "goa", "punjab", "haryana", "uttar pradesh", "delhi",
    "chandigarh", "assam", "odisha", "jharkhand", "chhattisgarh",
}

CITY_KEYS = list(CITY_STATE_MAP.keys())

NOISE_PATTERNS = [
    r"\bhub\b", r"\bregistered office\b", r"\bcorporate\b", r"\br&d centre\b",
    r"\bhead office\b", r"\bbranch\b", r"\bunit\s*\d*\b", r"\bmall\b",
    r"\bwork from home\b",
]

# ==================================================
# LOCATION CLEANING
# ==================================================

def clean_location(text: str) -> str:
    if not text or pd.isna(text) or str(text).lower() == 'nan':
        return ""
    t = str(text).strip()
    t = re.sub(r"\.\.\+\s*\d+", "", t)
    t = re.sub(r"\(.*?\)", "", t)
    t = re.sub(r"\d+\/\d+|\d+\s*mw.*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"sector[-\s]*\d+[a-z]*", "", t, flags=re.IGNORECASE)
    for pat in NOISE_PATTERNS:
        t = re.sub(pat, "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*-\s*$", "", t)
    t = re.sub(r",\s*,+", ",", t)
    t = re.sub(r"\s+", " ", t)
    t = t.strip(" ,-")
    return t

# ==================================================
# OFFLINE LOOKUP (fast path - no API call)
# ==================================================

def lookup_city(fragment: str, score_cutoff=90):
    """Exact match first, then strict fuzzy match with a length-ratio guard
    to avoid false positives on short strings (e.g. 'Bhagra' vs 'Agra')."""
    frag = fragment.strip().lower()
    if not frag:
        return None
    if frag in CITY_STATE_MAP:
        return CITY_STATE_MAP[frag]

    match = process.extractOne(frag, CITY_KEYS, scorer=fuzz.ratio, score_cutoff=score_cutoff)
    if match:
        matched_key = match[0]
        len_ratio = min(len(frag), len(matched_key)) / max(len(frag), len(matched_key))
        if len_ratio < 0.7:
            return None
        return CITY_STATE_MAP[matched_key]
    return None

def standardize_location_offline(cleaned: str):
    """Returns (result_string, resolved: bool). Tries to resolve using the
    static lookup only - no network calls."""
    if not cleaned:
        return "", True

    lower = cleaned.lower()
    if "remote" in lower:
        return "Remote", True
    if "head office" in lower and len(cleaned) < 20:
        return "Head Office", True

    fragments = [f.strip() for f in cleaned.split(",") if f.strip()]

    found_cities = []
    for frag in fragments:
        if frag.lower() == "india":
            continue
        if frag.lower() in INDIAN_STATES and frag.lower() not in CITY_STATE_MAP:
            continue
        result = lookup_city(frag)
        if result:
            city, state = result
            if city not in [c for c, s in found_cities]:
                found_cities.append((city, state))

    if not found_cities:
        return "", False  # unresolved -> caller should try LLM fallback

    if len(found_cities) == 1:
        city, state = found_cities[0]
        return f"{city}, {state}, India", True

    states = set(s for c, s in found_cities)
    city_names = [c for c, s in found_cities[:2]]
    if len(states) == 1:
        state = found_cities[0][1]
        city_names = [c for c in city_names if c.lower() != state.lower()]
        if not city_names:
            city_names = [found_cities[0][0]]
        return f"{', '.join(city_names)}, {state}, India", True
    else:
        return f"{', '.join(city_names)}, India", True

# ==================================================
# LLM FALLBACK (only for rows the offline lookup can't resolve)
# ==================================================

LOCATION_CACHE = {}

LOCATION_PROMPT_TEMPLATE = """You are a location normalization engine.

Normalize the input into ONE of these formats, and output ONLY the result on a single line — no explanation:

1. Single city: City, State, Country
2. Multiple cities, same country: City1, City2, Country
3. If not a real, identifiable place: UNKNOWN

Input: {location}
Output:"""

def post_process_location(llm_output: str) -> str:
    if not llm_output:
        return ""
    text = llm_output.strip().strip(",").strip()
    if text.upper() == "UNKNOWN":
        return ""

    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts:
        return ""

    deduped = []
    for p in parts:
        if not deduped or deduped[-1].lower() != p.lower():
            deduped.append(p)
    parts = deduped

    if len(parts) <= 3:
        return ", ".join(parts)

    country = parts[-1]
    cities = list(dict.fromkeys(parts[:-1]))
    if country in cities:
        cities.remove(country)
    return f"{', '.join(cities[:2])}, {country}"

def call_groq_location(cleaned_loc: str, retries: int = 3):
    global current_key_index

    for attempt in range(retries):
        active_key = GROQ_API_KEYS[current_key_index] if GROQ_API_KEYS else None
        if not active_key:
            print("No Groq API key available.")
            return None

        try:
            client = Groq(api_key=active_key)
            response = client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=[{"role": "user", "content": LOCATION_PROMPT_TEMPLATE.format(location=cleaned_loc)}],
                temperature=0,
                max_tokens=300,  # reasoning model needs headroom beyond just the answer
            )
            choice = response.choices[0]
            content = choice.message.content.strip() if choice.message.content else ""

            if not content and choice.finish_reason == "length":
                print(f"  [WARN] LLM truncated before producing content for '{cleaned_loc}'")
            return content

        except RateLimitError:
            print(f"Rate limit hit for '{cleaned_loc}'. Rotating key...")
            if GROQ_API_KEYS:
                current_key_index = (current_key_index + 1) % len(GROQ_API_KEYS)
            time.sleep(2)

        except Exception as e:
            print(f"Groq call failed (attempt {attempt+1}/{retries}) for '{cleaned_loc}': {e}")
            time.sleep(2 * (attempt + 1))

    return None

def standardize_location(raw_location) -> str:
    if pd.isna(raw_location) or not str(raw_location).strip():
        return ""

    cleaned = clean_location(raw_location)
    if not cleaned:
        return ""

    lower = cleaned.lower()
    if lower in LOCATION_CACHE:
        return LOCATION_CACHE[lower]

    # 1. Try fast offline lookup (no API call)
    result, resolved = standardize_location_offline(cleaned)
    if resolved:
        LOCATION_CACHE[lower] = result
        return result

    # 2. Fall back to LLM only for what the lookup couldn't resolve
    raw_result = call_groq_location(cleaned)
    if raw_result is None:
        print(f"  [FAILED] '{cleaned}' - LLM call failed after retries")
        result = ""
    else:
        first_line = raw_result.split("\n")[0]
        result = post_process_location(first_line)
        if not result:
            print(f"  [UNRESOLVED] '{cleaned}' -> raw LLM output: {raw_result!r}")

    LOCATION_CACHE[lower] = result
    return result

# ==================================================
# SUPABASE HELPERS
# ==================================================

def supabase_execute_with_retry(query_builder, retries=5):
    for attempt in range(retries):
        try:
            return query_builder.execute()
        except Exception as e:
            wait_time = (attempt + 1) * 2
            print(f"Network Error (Attempt {attempt+1}): {e}")
            time.sleep(wait_time)
    print("Critical: Supabase request failed.")
    return None

def fetch_target_rows_with_null_location(limit=None):
    """
    Fetch rows from jobs_uploadable_wp where location is NULL or an empty string,
    paginated. Returns list of dicts with job_id, source_table.
    """
    all_rows = []
    offset = 0

    while True:
        fetch_size = BATCH_SIZE
        if limit is not None:
            remaining = limit - len(all_rows)
            if remaining <= 0:
                break
            fetch_size = min(BATCH_SIZE, remaining)

        print(f"Fetching jobs_uploadable_wp rows (location empty/NULL) {offset} to {offset + fetch_size}...")
        query_builder = (
            supabase.table(TARGET_TABLE)
            .select("job_id, source_table, location")
            .or_("location.is.null,location.eq.")
            .range(offset, offset + fetch_size - 1)
        )
        res = supabase_execute_with_retry(query_builder)

        if not res or not res.data:
            print("No more empty/NULL-location rows. Fetch complete.")
            break

        all_rows.extend(res.data)
        offset += fetch_size

        if len(res.data) < fetch_size:
            break
        if limit is not None and len(all_rows) >= limit:
            break

    return all_rows[:limit] if limit else all_rows

def fetch_jobs_locations_by_ids(job_ids):
    """Fetch id, location from jobs table for a specific list of ids."""
    all_rows = []
    CHUNK = 500  # supabase .in_() works fine at this size

    for i in range(0, len(job_ids), CHUNK):
        chunk_ids = job_ids[i:i + CHUNK]
        query_builder = (
            supabase.table(JOBS_TABLE)
            .select("id, location")
            .in_("id", chunk_ids)
        )
        res = supabase_execute_with_retry(query_builder)
        if res and res.data:
            all_rows.extend(res.data)

    return all_rows

def update_locations_in_target(update_rows):
    """
    Update jobs_uploadable_wp.location + is_synced=False for the given rows.
    update_rows: list of dicts with job_id, source_table, location.
    Uses upsert since (job_id, source_table) is the composite primary key,
    and upsert only touches the columns provided.
    """
    total_updated = 0
    for i in range(0, len(update_rows), UPDATE_BATCH_SIZE):
        batch = update_rows[i:i + UPDATE_BATCH_SIZE]
        query_builder = (
            supabase.table(TARGET_TABLE)
            .upsert(batch, on_conflict="job_id,source_table")
        )
        res = supabase_execute_with_retry(query_builder)
        if res:
            total_updated += len(batch)
            print(f"  Updated batch: {len(batch)} rows (running total: {total_updated})")
        else:
            print(f"  FAILED to update batch of {len(batch)} rows (job_ids: {[r['job_id'] for r in batch]})")

    return total_updated

# ==================================================
# MAIN
# ==================================================

def run():
    # 1. Find rows in jobs_uploadable_wp that need a location (currently empty/NULL)
    target_rows = fetch_target_rows_with_null_location(limit=TEST_LIMIT)
    if not target_rows:
        print("No rows with empty/NULL location found in jobs_uploadable_wp. Nothing to do.")
        return

    job_ids = [r["job_id"] for r in target_rows]
    source_table_by_id = {r["job_id"]: r["source_table"] for r in target_rows}
    print(f"Found {len(job_ids)} rows in {TARGET_TABLE} with empty/NULL location.")

    # 2. Pull the raw location for those same job ids from jobs
    print("Fetching raw locations from jobs table...")
    jobs_rows = fetch_jobs_locations_by_ids(job_ids)
    jobs_df = pd.DataFrame(jobs_rows)

    if jobs_df.empty:
        print("No matching rows found in jobs table. Nothing to do.")
        return

    print(f"Fetched {len(jobs_df)} matching rows from jobs. Standardizing locations...")

    # 3. Standardize
    standardized = []
    offline_count = 0
    llm_count = 0

    for i, raw_loc in enumerate(jobs_df["location"], start=1):
        cleaned = clean_location(raw_loc) if pd.notna(raw_loc) else ""
        _, resolved_offline = standardize_location_offline(cleaned) if cleaned else ("", True)

        std_loc = standardize_location(raw_loc)
        standardized.append(std_loc)

        if resolved_offline:
            offline_count += 1
        else:
            llm_count += 1

        if i % 25 == 0:
            print(f"  Standardized {i}/{len(jobs_df)}")

    jobs_df["standardized_location"] = standardized

    # 4. Build update payload for jobs_uploadable_wp
    #    Skip rows where standardization produced an empty string (nothing to write).
    update_rows = []
    skipped_empty = 0

    for _, row in jobs_df.iterrows():
        job_id = int(row["id"])
        std_loc = row["standardized_location"]

        if not std_loc:
            skipped_empty += 1
            continue

        update_rows.append({
            "job_id": job_id,
            "source_table": source_table_by_id.get(job_id, JOBS_TABLE),
            "location": std_loc,
            "is_synced": False,
        })

    print(f"\nPrepared {len(update_rows)} rows to update. Skipped {skipped_empty} (empty/unresolved location).")

    # 5. Push updates to jobs_uploadable_wp
    if update_rows:
        total_updated = update_locations_in_target(update_rows)
        print(f"\nDone. Updated {total_updated} rows in {TARGET_TABLE}.")
    else:
        print("Nothing to update.")

    print(f"Resolved offline (no API call): {offline_count}")
    print(f"Needed LLM fallback: {llm_count}")

if __name__ == "__main__":
    run()