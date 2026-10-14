#!/usr/bin/env bash
set -euo pipefail

asset_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_image=${1:-"$asset_dir/stoasis-scene.jpg"}
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

if ! command -v magick >/dev/null 2>&1; then
	printf 'ImageMagick 7 is required (missing: magick).\n' >&2
	exit 1
fi

if [[ ! -f "$source_image" ]]; then
	printf 'Required file not found: %s\n' "$source_image" >&2
	exit 1
fi

xml_escape() {
	printf '%s' "$1" | sed \
		-e 's/&/\&amp;/g' \
		-e 's/</\&lt;/g' \
		-e 's/>/\&gt;/g' \
		-e 's/"/\&quot;/g' \
		-e "s/'/\&apos;/g"
}

write_card() {
	local x=$1
	local y=$2
	local width=$3
	local height=$4
	local accent=$5
	local label=$6
	local status=$7
	local font_size=$8
	local status_size=$9
	local label_x=$((x + 26))
	local label_y=$((y + 43))
	local status_y=$((y + height - 22))
	local line_x2=$((x + width - 25))
	local escaped_label
	local escaped_status
	escaped_label=$(xml_escape "$label")
	escaped_status=$(xml_escape "$status")
	printf '<g>\n'
	printf '  <rect x="%s" y="%s" width="%s" height="%s" rx="24" fill="url(#glass)" stroke="url(#rim)" stroke-width="1.5"/>\n' "$x" "$y" "$width" "$height"
	printf '  <line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" stroke-width="3" stroke-linecap="round"/>\n' "$label_x" "$((y + 18))" "$line_x2" "$((y + 18))" "$accent"
	printf '  <text x="%s" y="%s" class="card" font-size="%s">%s</text>\n' "$label_x" "$label_y" "$font_size" "$escaped_label"
	printf '  <circle cx="%s" cy="%s" r="5" fill="%s"/>\n' "$label_x" "$((status_y - 5))" "$accent"
	printf '  <text x="%s" y="%s" class="status" font-size="%s">%s</text>\n' "$((label_x + 16))" "$status_y" "$status_size" "$escaped_status"
	printf '</g>\n'
}

write_overlay() {
	local output=$1
	local width=$2
	local height=$3
	local title_x=$4
	local title_y=$5
	local title_size=$6
	local tagline_y=$7
	local cards_y=$8
	local card_width=$9
	local card_height=${10}
	local first_x=${11}
	local gap=${12}
	local card_font=${13}
	local status_font=${14}

	{
		printf '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">\n' "$width" "$height" "$width" "$height"
		printf '<defs>\n'
		printf '  <linearGradient id="scrim" x1="0" x2="1"><stop offset="0" stop-color="#170b2e" stop-opacity=".94"/><stop offset=".52" stop-color="#170b2e" stop-opacity=".54"/><stop offset="1" stop-color="#170b2e" stop-opacity="0"/></linearGradient>\n'
		printf '  <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4ecff" stop-opacity=".18"/><stop offset=".28" stop-color="#221040" stop-opacity=".82"/><stop offset="1" stop-color="#170b2e" stop-opacity=".68"/></linearGradient>\n'
		printf '  <linearGradient id="rim"><stop offset="0" stop-color="#f4ecff" stop-opacity=".74"/><stop offset=".48" stop-color="#05e5d8" stop-opacity=".42"/><stop offset="1" stop-color="#ff2e97" stop-opacity=".5"/></linearGradient>\n'
		printf '  <filter id="shadow" x="-30%%" y="-30%%" width="160%%" height="160%%"><feGaussianBlur stdDeviation="8"/></filter>\n'
		printf '  <style>\n'
		printf '    .title { font-family: DejaVu Sans, sans-serif; font-weight: 700; letter-spacing: .045em; fill: #f4ecff; }\n'
		printf '    .eyebrow, .status { font-family: DejaVu Sans Mono, monospace; letter-spacing: .12em; fill: #f4ecff; }\n'
		printf '    .tagline { font-family: DejaVu Sans, sans-serif; fill: #f4ecff; }\n'
		printf '    .card { font-family: DejaVu Sans, sans-serif; font-weight: 700; fill: #f4ecff; }\n'
		printf '  </style>\n'
		printf '</defs>\n'
		printf '<rect width="%s" height="%s" fill="url(#scrim)"/>\n' "$((width * 3 / 5))" "$height"
		printf '<rect x="%s" y="%s" width="%s" height="%s" rx="28" fill="#05e5d8" opacity=".24" filter="url(#shadow)"/>\n' "$((title_x - 6))" "$((title_y - title_size + 8))" "$((title_size * 4))" "$((title_size + 18))"
		printf '<text x="%s" y="%s" class="eyebrow" font-size="16">OPEN-SOURCE OBSIDIAN PLUGIN</text>\n' "$title_x" "$((title_y - title_size - 34))"
		printf '<text x="%s" y="%s" class="title" font-size="%s">Stoasis</text>\n' "$title_x" "$title_y" "$title_size"
		printf '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#05e5d8" stroke-width="4" stroke-linecap="round"/>\n' "$title_x" "$((title_y + 24))" "$((title_x + title_size * 2))" "$((title_y + 24))"
		printf '<circle cx="%s" cy="%s" r="5" fill="#ff2e97"/>\n' "$((title_x + title_size * 2 + 18))" "$((title_y + 24))"
		printf '<text x="%s" y="%s" class="tagline" font-size="%s">A shared oasis for your notes.</text>\n' "$title_x" "$tagline_y" "$((title_size / 5))"

		write_card "$first_x" "$cards_y" "$card_width" "$card_height" '#05e5d8' 'Pairing link' 'SHIPPED' "$card_font" "$status_font"
		write_card "$((first_x + card_width + gap))" "$cards_y" "$card_width" "$card_height" '#ff2e97' 'Live sync' 'PLANNED' "$card_font" "$status_font"
		write_card "$((first_x + (card_width + gap) * 2))" "$cards_y" "$card_width" "$card_height" '#ffe37b' 'Shared spaces' 'PLANNED' "$card_font" "$status_font"
		write_card "$((first_x + (card_width + gap) * 3))" "$cards_y" "$card_width" "$card_height" '#9c87c4' 'AI tags' 'PLANNED' "$card_font" "$status_font"
		printf '</svg>\n'
	} > "$output"
}

make_base() {
	local output=$1
	local width=$2
	local height=$3
	magick "$source_image" -auto-orient -resize "${width}x${height}^" \
		-gravity center -extent "${width}x${height}" -strip "$output"
}

render_png() {
	local base=$1
	local overlay=$2
	local output=$3
	magick "$base" \( -background none "$overlay" \) -composite -strip \
		-dither Riemersma -colors 80 -define png:compression-level=9 \
		-define png:compression-filter=5 "$output"
}

hero_overlay="$asset_dir/stoasis-hero-overlay.svg"
social_overlay="$asset_dir/stoasis-social-preview-overlay.svg"

write_overlay "$hero_overlay" 1998 700 72 242 138 300 538 430 112 54 26 23 14
write_overlay "$social_overlay" 1280 640 58 202 104 252 490 272 104 50 32 19 12

make_base "$work_dir/hero-base.png" 1998 700
make_base "$work_dir/social-base.png" 1280 640
render_png "$work_dir/hero-base.png" "$hero_overlay" "$asset_dir/stoasis-hero.png"
render_png "$work_dir/social-base.png" "$social_overlay" "$asset_dir/stoasis-social-preview.png"

printf 'Rendered:\n  %s\n  %s\n' \
	"$asset_dir/stoasis-hero.png" \
	"$asset_dir/stoasis-social-preview.png"
