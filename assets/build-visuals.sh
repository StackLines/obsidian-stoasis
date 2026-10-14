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

write_overlay() {
	local output=$1
	local width=$2
	local height=$3
	local title_x=$4
	local title_y=$5
	local title_size=$6
	local tagline_y=$7
	local eyebrow_width=$8
	local eyebrow_size=$9
	local panel_width=$((title_size * 5))
	local panel_height=$((title_size * 2 + 70))
	local panel_x=$((title_x - 30))
	local panel_y=$((title_y - title_size - 72))
	local eyebrow_y=$((title_y - title_size - 50))

	{
		printf '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="0 0 %s %s">\n' "$width" "$height" "$width" "$height"
		printf '<defs>\n'
		printf '  <linearGradient id="scrim" x1="0" x2="1"><stop offset="0" stop-color="#070a12" stop-opacity=".92"/><stop offset=".54" stop-color="#0d1422" stop-opacity=".48"/><stop offset="1" stop-color="#070a12" stop-opacity="0"/></linearGradient>\n'
		printf '  <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b7e6ff" stop-opacity=".10"/><stop offset=".28" stop-color="#121b2d" stop-opacity=".38"/><stop offset="1" stop-color="#070a12" stop-opacity=".12"/></linearGradient>\n'
		printf '  <linearGradient id="titleInk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".58" stop-color="#e7f5ff"/><stop offset="1" stop-color="#a9d9f5"/></linearGradient>\n'
		printf '  <linearGradient id="accent" x1="0" x2="1"><stop offset="0" stop-color="#63d9ff"/><stop offset=".7" stop-color="#8f9cff"/><stop offset="1" stop-color="#e8b96a"/></linearGradient>\n'
		printf '  <filter id="shadow" x="-30%%" y="-30%%" width="160%%" height="160%%"><feGaussianBlur stdDeviation="10"/></filter>\n'
		printf '  <style>\n'
		printf '    .title { font-family: DejaVu Sans, sans-serif; font-weight: 700; letter-spacing: .055em; fill: url(#titleInk); }\n'
		printf '    .eyebrow { font-family: DejaVu Sans Mono, monospace; letter-spacing: .13em; fill: #cfeeff; }\n'
		printf '    .tagline { font-family: DejaVu Sans, sans-serif; letter-spacing: .02em; fill: #d9e8f2; }\n'
		printf '  </style>\n'
		printf '</defs>\n'
		printf '<rect width="%s" height="%s" fill="url(#scrim)"/>\n' "$((width * 7 / 12))" "$height"
		printf '<rect x="%s" y="%s" width="%s" height="%s" rx="30" fill="#63d9ff" opacity=".045" filter="url(#shadow)"/>\n' "$panel_x" "$panel_y" "$panel_width" "$panel_height"
		printf '<rect x="%s" y="%s" width="%s" height="40" rx="20" fill="url(#glass)" stroke="#b7e6ff" stroke-opacity=".32"/>\n' "$title_x" "$eyebrow_y" "$eyebrow_width"
		printf '<circle cx="%s" cy="%s" r="4" fill="#63d9ff"/>\n' "$((title_x + 20))" "$((eyebrow_y + 20))"
		printf '<text x="%s" y="%s" class="eyebrow" font-size="%s">OPEN-SOURCE OBSIDIAN PLUGIN</text>\n' "$((title_x + 36))" "$((eyebrow_y + 26))" "$eyebrow_size"
		printf '<text x="%s" y="%s" class="title" font-size="%s">Stoasis</text>\n' "$title_x" "$title_y" "$title_size"
		printf '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="url(#accent)" stroke-width="4" stroke-linecap="round"/>\n' "$title_x" "$((title_y + 24))" "$((title_x + title_size * 2 + 38))" "$((title_y + 24))"
		printf '<circle cx="%s" cy="%s" r="5" fill="#e8b96a"/>\n' "$((title_x + title_size * 2 + 56))" "$((title_y + 24))"
		printf '<text x="%s" y="%s" class="tagline" font-size="%s">A shared oasis for your notes.</text>\n' "$title_x" "$tagline_y" "$((title_size / 5))"
		printf '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#b7e6ff" stroke-opacity=".18"/>\n' "$title_x" "$((tagline_y + 44))" "$((title_x + title_size * 4))" "$((tagline_y + 44))"
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

write_overlay "$hero_overlay" 1998 700 76 252 138 312 344 14
write_overlay "$social_overlay" 1280 640 60 214 104 264 314 12

make_base "$work_dir/hero-base.png" 1998 700
make_base "$work_dir/social-base.png" 1280 640
render_png "$work_dir/hero-base.png" "$hero_overlay" "$asset_dir/stoasis-hero.png"
render_png "$work_dir/social-base.png" "$social_overlay" "$asset_dir/stoasis-social-preview.png"

printf 'Rendered:\n  %s\n  %s\n' \
	"$asset_dir/stoasis-hero.png" \
	"$asset_dir/stoasis-social-preview.png"
