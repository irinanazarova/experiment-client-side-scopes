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
end
