import { useEffect, useState } from "react";
import { todayIso } from "../../lib/vaulttasks/dates";

/**
 * Today's local date (`YYYY-MM-DD`), re-evaluated every minute and when the
 * window regains focus, so "Today" / "Overdue" roll over at midnight.
 */
export function useToday(): string {
  const [today, setToday] = useState(todayIso);
  useEffect(() => {
    const update = () => setToday(todayIso());
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, []);
  return today;
}
