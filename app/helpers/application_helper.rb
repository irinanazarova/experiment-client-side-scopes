module ApplicationHelper
  # The one number format the grid uses everywhere. Whole numbers, comma
  # delimited. Mirrors the JS `fmt` (toLocaleString, maximumFractionDigits: 0),
  # so server-rendered and JS-rendered markup morph into each other without churn.
  #
  # Hand-rolled rather than number_with_precision: this is the grid's hottest
  # call (the visible window is ~500 cells, re-rendered on every edit), and in
  # the in-browser Rails VM the full NumberHelper machinery dominated the
  # region render. This is ~11x faster for byte-identical output (round
  # half-up, comma every three digits), so the in-tab re-render is ~10x
  # cheaper. Verified equal across random + edge values (nil, 0, negatives,
  # billions, .5 rounding).
  def cell_number(value)
    return "" if value.nil?

    int = (value.is_a?(::Numeric) ? value : BigDecimal(value.to_s)).round
    sign = int.negative? ? "-" : ""
    "#{sign}#{int.abs.to_s.reverse.gsub(/(\d{3})(?=\d)/, '\1,').reverse}"
  end

  # Render a named reactive region: the region element carries the watch SQL
  # (the browser runs it as a live query) and the first paint of its partial.
  # When the live query fires, the JS runtime re-fetches the region and morphs
  # just this element. See LiveRegion and public/live.mjs.
  #
  #   <%= live_region :totals, sheet: @sheet, tag: :tbody, id: "grid-totals" %>
  def live_region(name, sheet:, tag: :div, **html)
    region = ::LiveRegion.fetch(name)
    data = (html.delete(:data) || {}).merge(
      live_region: name, sheet_id: sheet.id, watch: region.watch_sql(sheet)
    )
    content_tag(tag, **html, data: data) do
      render partial: region.partial, locals: region.locals(sheet)
    end
  end
end
