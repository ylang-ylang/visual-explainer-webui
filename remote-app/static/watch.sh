#!/bin/sh
# Visual Explainer zero-dependency POSIX comment watcher (0 idle LLM tokens).
# Requires only POSIX sh + curl. Auth key is supplied via VE_KEY env var and
# passed to curl strictly through stdin (-K -), never in argv / ps aux.
set -eu

URL="${VE_EVENTS_URL:-}"
AFTER="${VE_AFTER:-}"
EVENTS="${VE_EVENTS:-}"
WATCH_PATH="${VE_PATH:-}"
EXPLAINER="${VE_EXPLAINER:-}"
CLIENT="${VE_CLIENT:-agent}"
TIMEOUT="${VE_TIMEOUT:-300}"
MAX_IDLE_SEC="${VE_MAX_IDLE_SEC:-0}"
MODE="${VE_MODE:-once}"
PID_FILE="${VE_PID_FILE:-}"
NO_SINGLETON="${VE_NO_SINGLETON:-0}"

usage() {
  cat <<'USAGE'
Usage: VE_KEY=<token> ./ve-watch.sh --url <events-url> [options]

Options:
  --url <url>           Events endpoint URL (or VE_EVENTS_URL)
  --after <id>          Resume after event ID (or VE_AFTER)
  --events <csv>        Filter event types (or VE_EVENTS; omitted = all comment events)
  --path <relpath>      Filter to one page path (or VE_PATH; omitted = entire folder)
  --explainer <id>      Filter to one skill explainer (or VE_EXPLAINER)
  --client <name>       Client label shown in WebUI (default: agent)
  --timeout <sec>       Long-poll chunk duration in seconds, 1-3600 (default: 300)
  --max-idle-sec <sec>  Max idle wait seconds; 0 = follow key lifetime (default: 0)
  --mode once|stream    once = exit 0 with 1 JSON event; stream = continuous NDJSON
  --pid-file <path>     Custom singleton PID lock path (or VE_PID_FILE)
  --no-singleton        Disable automatic replacement of prior watcher for same scope
  -h, --help            Show this help message
USAGE
}

die_err() {
  printf '{"status":"error","error":"%s"}\n' "$1" >&2
  exit 1
}

is_nonneg_int() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

NL='
'
CR=$(printf '\r')

reject_newlines() {
  case "$2" in
    *"$NL"*|*"$CR"*) die_err "$1 must not contain newline characters" ;;
  esac
}

curl_escape() {
  _ce_in="$1"
  _ce_out=""
  while [ -n "$_ce_in" ]; do
    _ce_c="${_ce_in%"${_ce_in#?}"}"
    _ce_in="${_ce_in#?}"
    case "$_ce_c" in
      \\) _ce_out="${_ce_out}\\\\" ;;
      \") _ce_out="${_ce_out}\\\"" ;;
      *)  _ce_out="${_ce_out}${_ce_c}" ;;
    esac
  done
  printf '%s' "$_ce_out"
}

json_escape() {
  _je_in="$1"
  _je_out=""
  while [ -n "$_je_in" ]; do
    _je_c="${_je_in%"${_je_in#?}"}"
    _je_in="${_je_in#?}"
    case "$_je_c" in
      \\) _je_out="${_je_out}\\\\" ;;
      \") _je_out="${_je_out}\\\"" ;;
      "$NL") _je_out="${_je_out}\\n" ;;
      "$CR") _je_out="${_je_out}\\r" ;;
      *)  _je_out="${_je_out}${_je_c}" ;;
    esac
  done
  printf '%s' "$_je_out"
}

now_epoch() {
  date +%s 2>/dev/null || printf '0'
}

next_backoff() {
  case "$1" in
    2)  printf '5' ;;
    5)  printf '10' ;;
    10) printf '30' ;;
    *)  printf '30' ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)          [ $# -ge 2 ] || die_err "Missing value for --url"; URL="$2"; shift 2 ;;
    --url=*)        URL="${1#--url=}"; shift ;;
    --after)        [ $# -ge 2 ] || die_err "Missing value for --after"; AFTER="$2"; shift 2 ;;
    --after=*)      AFTER="${1#--after=}"; shift ;;
    --events)       [ $# -ge 2 ] || die_err "Missing value for --events"; EVENTS="$2"; shift 2 ;;
    --events=*)     EVENTS="${1#--events=}"; shift ;;
    --path)         [ $# -ge 2 ] || die_err "Missing value for --path"; WATCH_PATH="$2"; shift 2 ;;
    --path=*)       WATCH_PATH="${1#--path=}"; shift ;;
    --explainer)    [ $# -ge 2 ] || die_err "Missing value for --explainer"; EXPLAINER="$2"; shift 2 ;;
    --explainer=*)  EXPLAINER="${1#--explainer=}"; shift ;;
    --client)       [ $# -ge 2 ] || die_err "Missing value for --client"; CLIENT="$2"; shift 2 ;;
    --client=*)     CLIENT="${1#--client=}"; shift ;;
    --timeout)      [ $# -ge 2 ] || die_err "Missing value for --timeout"; TIMEOUT="$2"; shift 2 ;;
    --timeout=*)    TIMEOUT="${1#--timeout=}"; shift ;;
    --max-idle-sec) [ $# -ge 2 ] || die_err "Missing value for --max-idle-sec"; MAX_IDLE_SEC="$2"; shift 2 ;;
    --max-idle-sec=*) MAX_IDLE_SEC="${1#--max-idle-sec=}"; shift ;;
    --mode)         [ $# -ge 2 ] || die_err "Missing value for --mode"; MODE="$2"; shift 2 ;;
    --mode=*)       MODE="${1#--mode=}"; shift ;;
    --pid-file)     [ $# -ge 2 ] || die_err "Missing value for --pid-file"; PID_FILE="$2"; shift 2 ;;
    --pid-file=*)   PID_FILE="${1#--pid-file=}"; shift ;;
    --no-singleton) NO_SINGLETON=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die_err "Unknown argument: $(json_escape "$1")" ;;
  esac
done

[ -n "$URL" ] || die_err "Missing required --url (or VE_EVENTS_URL)"
[ -n "${VE_KEY:-}" ] || die_err "Missing required VE_KEY environment variable"
command -v curl >/dev/null 2>&1 || die_err "curl is required"

case "$MODE" in
  once|stream) ;;
  *) die_err "Invalid --mode (expected once or stream)" ;;
esac

if ! is_nonneg_int "$TIMEOUT" || [ "$TIMEOUT" -lt 1 ] || [ "$TIMEOUT" -gt 3600 ]; then
  die_err "Invalid --timeout (expected integer 1-3600)"
fi
if ! is_nonneg_int "$MAX_IDLE_SEC"; then
  die_err "Invalid --max-idle-sec (expected non-negative integer)"
fi

reject_newlines "VE_KEY" "$VE_KEY"
reject_newlines "URL" "$URL"
reject_newlines "after" "$AFTER"
reject_newlines "events" "$EVENTS"
reject_newlines "path" "$WATCH_PATH"
reject_newlines "explainer" "$EXPLAINER"
reject_newlines "client" "$CLIENT"

CLEANED_UP=0
CHILD_PID=""
TMP_DIR=""
OWN_PID_FILE=""

cleanup() {
  [ "$CLEANED_UP" -eq 1 ] && return 0
  CLEANED_UP=1
  if [ -n "$CHILD_PID" ]; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
  if [ -n "$OWN_PID_FILE" ] && [ -f "$OWN_PID_FILE" ]; then
    _cur_pid=$(cat "$OWN_PID_FILE" 2>/dev/null || true)
    if [ "$_cur_pid" = "$$" ]; then
      rm -f "$OWN_PID_FILE" 2>/dev/null || true
    fi
  fi
}

on_signal() {
  _sig_rc="$1"
  cleanup
  trap - EXIT
  exit "$_sig_rc"
}

trap 'cleanup' EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

sleep_interruptible() {
  sleep "$1" &
  CHILD_PID=$!
  wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""
}

compute_scope_hash() {
  _ck=$(printf '%s|%s|%s|%s' "$URL" "$WATCH_PATH" "$EXPLAINER" "$MODE" | cksum)
  set -- $_ck
  printf '%s-%s' "$1" "$2"
}

if [ "$NO_SINGLETON" != "1" ]; then
  if [ -z "$PID_FILE" ]; then
    _runtime_dir="${XDG_RUNTIME_DIR:-/tmp}"
    if [ ! -d "$_runtime_dir" ] || [ ! -w "$_runtime_dir" ]; then
      _runtime_dir="/tmp"
    fi
    _scope_hash=$(compute_scope_hash)
    PID_FILE="${_runtime_dir}/ve-watch-${_scope_hash}.pid"
  fi
  if [ -f "$PID_FILE" ]; then
    _old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if is_nonneg_int "$_old_pid" && [ "$_old_pid" -gt 1 ] && [ "$_old_pid" != "$$" ]; then
      if kill -0 "$_old_pid" 2>/dev/null; then
        kill -TERM "$_old_pid" 2>/dev/null || true
        _waits=0
        while kill -0 "$_old_pid" 2>/dev/null && [ "$_waits" -lt 15 ]; do
          sleep 0.1 2>/dev/null || sleep 1
          _waits=$((_waits + 1))
        done
        if kill -0 "$_old_pid" 2>/dev/null; then
          kill -KILL "$_old_pid" 2>/dev/null || true
        fi
      fi
    fi
  fi
  _pid_tmp="${PID_FILE}.tmp.$$"
  printf '%s\n' "$$" > "$_pid_tmp"
  mv -f "$_pid_tmp" "$PID_FILE"
  OWN_PID_FILE="$PID_FILE"
fi

OLD_UMASK=$(umask)
umask 077
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ve-watch.XXXXXX" 2>/dev/null || true)
if [ -z "$TMP_DIR" ] || [ ! -d "$TMP_DIR" ]; then
  TMP_DIR="${TMPDIR:-/tmp}/ve-watch.$$"
  mkdir -p "$TMP_DIR"
fi
umask "$OLD_UMASK"

AUTH_ESC=$(curl_escape "$VE_KEY")
CLIENT_ESC=$(curl_escape "$CLIENT")
EVENTS_ESC=$(curl_escape "$EVENTS")
PATH_ESC=$(curl_escape "$WATCH_PATH")
EXPLAINER_ESC=$(curl_escape "$EXPLAINER")

CURL_CFG=""
build_curl_cfg() {
  _b_once="$1"
  _b_timeout="$2"
  _b_after="$3"
  _b_accept="$4"
  _cfg="header = \"Authorization: Bearer ${AUTH_ESC}\""
  if [ -n "$_b_accept" ]; then
    _cfg="${_cfg}${NL}header = \"Accept: ${_b_accept}\""
  fi
  if [ -n "$_b_once" ]; then
    _cfg="${_cfg}${NL}data-urlencode = \"once=1\""
    _cfg="${_cfg}${NL}data-urlencode = \"timeout=${_b_timeout}\""
  fi
  if [ -n "$CLIENT_ESC" ]; then
    _cfg="${_cfg}${NL}data-urlencode = \"client=${CLIENT_ESC}\""
  fi
  if [ -n "$EVENTS_ESC" ]; then
    _cfg="${_cfg}${NL}data-urlencode = \"events=${EVENTS_ESC}\""
  fi
  if [ -n "$PATH_ESC" ]; then
    _cfg="${_cfg}${NL}data-urlencode = \"path=${PATH_ESC}\""
  fi
  if [ -n "$EXPLAINER_ESC" ]; then
    _cfg="${_cfg}${NL}data-urlencode = \"explainer=${EXPLAINER_ESC}\""
  fi
  if [ -n "$_b_after" ]; then
    _after_esc=$(curl_escape "$_b_after")
    _cfg="${_cfg}${NL}data-urlencode = \"after=${_after_esc}\""
  fi
  CURL_CFG="$_cfg"
}

emit_http_error() {
  _e_code="$1"
  _e_file="$2"
  _e_body=$(cat "$_e_file" 2>/dev/null || true)
  if [ -n "$_e_body" ]; then
    printf '{"status":"error","httpCode":%s,"error":"%s"}\n' "$_e_code" "$(json_escape "$_e_body")" >&2
  else
    printf '{"status":"error","httpCode":%s,"error":"Unexpected HTTP status"}\n' "$_e_code" >&2
  fi
}

if [ "$MODE" = "once" ]; then
  BODY_FILE="${TMP_DIR}/body"
  CODE_FILE="${TMP_DIR}/code"
  ERR_FILE="${TMP_DIR}/err"
  BACKOFF=2
  IDLE_START=$(now_epoch)
  IDLE_SEC=0

  while :; do
    REQ_TIMEOUT="$TIMEOUT"
    if [ "$MAX_IDLE_SEC" -gt 0 ]; then
      NOW=$(now_epoch)
      IDLE_SEC=$((NOW - IDLE_START))
      REM=$((MAX_IDLE_SEC - IDLE_SEC))
      if [ "$REM" -le 0 ]; then
        printf '{"status":"idle_timeout","idleSec":%s,"action":"stop"}\n' "$IDLE_SEC"
        exit 0
      fi
      if [ "$REM" -lt "$REQ_TIMEOUT" ]; then
        REQ_TIMEOUT="$REM"
      fi
    fi

    build_curl_cfg "1" "$REQ_TIMEOUT" "$AFTER" ""
    CURL_MAX_TIME=$((REQ_TIMEOUT + 30))
    : > "$BODY_FILE"
    : > "$CODE_FILE"
    : > "$ERR_FILE"

    curl -sS -G \
      --connect-timeout 15 \
      --max-time "$CURL_MAX_TIME" \
      -o "$BODY_FILE" \
      -w '%{http_code}' \
      -K - \
      "$URL" <<EOF > "$CODE_FILE" 2> "$ERR_FILE" &
$CURL_CFG
EOF
    CHILD_PID=$!
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""

    HTTP_CODE=$(cat "$CODE_FILE" 2>/dev/null || true)
    case "$HTTP_CODE" in
      [0-9][0-9][0-9]) ;;
      *) HTTP_CODE="000" ;;
    esac

    case "$HTTP_CODE" in
      200)
        cat "$BODY_FILE"
        printf '\n'
        exit 0
        ;;
      204)
        BACKOFF=2
        if [ "$MAX_IDLE_SEC" -gt 0 ]; then
          NOW=$(now_epoch)
          IDLE_SEC=$((NOW - IDLE_START))
          if [ "$IDLE_SEC" -ge "$MAX_IDLE_SEC" ]; then
            printf '{"status":"idle_timeout","idleSec":%s,"action":"stop"}\n' "$IDLE_SEC"
            exit 0
          fi
        fi
        ;;
      401|403)
        printf '{"status":"key_expired","httpCode":%s,"action":"stop"}\n' "$HTTP_CODE"
        exit 0
        ;;
      404)
        printf '{"status":"scope_gone","httpCode":404,"action":"stop"}\n'
        exit 0
        ;;
      000|429|500|502|503|504)
        if [ "$MAX_IDLE_SEC" -gt 0 ]; then
          NOW=$(now_epoch)
          IDLE_SEC=$((NOW - IDLE_START))
          if [ "$IDLE_SEC" -ge "$MAX_IDLE_SEC" ]; then
            printf '{"status":"idle_timeout","idleSec":%s,"action":"stop"}\n' "$IDLE_SEC"
            exit 0
          fi
        fi
        sleep_interruptible "$BACKOFF"
        BACKOFF=$(next_backoff "$BACKOFF")
        ;;
      *)
        emit_http_error "$HTTP_CODE" "$BODY_FILE"
        exit 1
        ;;
    esac
  done
else
  HDR_FILE="${TMP_DIR}/headers"
  ERR_FILE="${TMP_DIR}/err"
  SSE_FIFO="${TMP_DIR}/sse.fifo"
  mkfifo "$SSE_FIFO"
  BACKOFF=2
  LAST_EVENT_ID="$AFTER"

  while :; do
    build_curl_cfg "" "" "$LAST_EVENT_ID" "text/event-stream"
    : > "$HDR_FILE"
    : > "$ERR_FILE"

    curl -sS -G -N --no-buffer \
      --connect-timeout 15 \
      -D "$HDR_FILE" \
      -K - \
      "$URL" <<EOF > "$SSE_FIFO" 2> "$ERR_FILE" &
$CURL_CFG
EOF
    CHILD_PID=$!

    EV_TYPE=""
    EV_DATA=""
    STOP_STATUS=""
    SAW_CONNECTED=0

    while IFS= read -r _line || [ -n "$_line" ]; do
      _line="${_line%"$CR"}"
      if [ -z "$_line" ]; then
        if [ "$EV_TYPE" = "auth.expired" ]; then
          case "$EV_DATA" in
            *'"scope_gone"'*) STOP_STATUS="scope_gone" ;;
            *) STOP_STATUS="key_expired" ;;
          esac
          break
        fi
        if [ -n "$EV_DATA" ]; then
          printf '%s\n' "$EV_DATA"
        fi
        EV_TYPE=""
        EV_DATA=""
        continue
      fi
      case "$_line" in
        :*)
          SAW_CONNECTED=1
          BACKOFF=2
          ;;
        id:*)
          _val="${_line#id:}"
          case "$_val" in " "*) _val="${_val#" "}" ;; esac
          if [ -n "$_val" ]; then
            LAST_EVENT_ID="$_val"
          fi
          ;;
        event:*)
          _val="${_line#event:}"
          case "$_val" in " "*) _val="${_val#" "}" ;; esac
          EV_TYPE="$_val"
          ;;
        data:*)
          _val="${_line#data:}"
          case "$_val" in " "*) _val="${_val#" "}" ;; esac
          if [ -n "$EV_DATA" ]; then
            EV_DATA="${EV_DATA}${NL}${_val}"
          else
            EV_DATA="$_val"
          fi
          ;;
      esac
    done < "$SSE_FIFO"

    if [ -n "$STOP_STATUS" ]; then
      if [ -n "$CHILD_PID" ]; then
        kill -TERM "$CHILD_PID" 2>/dev/null || true
        wait "$CHILD_PID" 2>/dev/null || true
        CHILD_PID=""
      fi
      printf '{"status":"%s","action":"stop"}\n' "$STOP_STATUS"
      exit 0
    fi

    if [ -n "$CHILD_PID" ]; then
      wait "$CHILD_PID" 2>/dev/null || true
      CHILD_PID=""
    fi

    HTTP_CODE="000"
    if [ -f "$HDR_FILE" ]; then
      while IFS= read -r _hline; do
        _hline="${_hline%"$CR"}"
        case "$_hline" in
          HTTP/*\ [0-9][0-9][0-9]*)
            _rest="${_hline#* }"
            _code="${_rest%% *}"
            case "$_code" in
              [0-9][0-9][0-9]) HTTP_CODE="$_code" ;;
            esac
            ;;
        esac
      done < "$HDR_FILE"
    fi

    case "$HTTP_CODE" in
      401|403)
        printf '{"status":"key_expired","httpCode":%s,"action":"stop"}\n' "$HTTP_CODE"
        exit 0
        ;;
      404)
        printf '{"status":"scope_gone","httpCode":404,"action":"stop"}\n'
        exit 0
        ;;
      200)
        if [ "$SAW_CONNECTED" -eq 1 ]; then
          BACKOFF=2
        fi
        sleep_interruptible "$BACKOFF"
        BACKOFF=$(next_backoff "$BACKOFF")
        ;;
      000|429|500|502|503|504)
        sleep_interruptible "$BACKOFF"
        BACKOFF=$(next_backoff "$BACKOFF")
        ;;
      *)
        emit_http_error "$HTTP_CODE" "$ERR_FILE"
        exit 1
        ;;
    esac
  done
fi
