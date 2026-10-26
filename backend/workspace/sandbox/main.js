function drawBurjKhalifa() {
  const base = [
    "   _____",
    "  /     \\",
    " /       \\",
    "|  _____  |",
    "| |     | |",
    "| |  O  | |",
    "| |_____ |",
    "|________|"
  ];

  // Add a simple stick‑figure on top
  const man = "    O   ";
  const arms = "   /|\\  ";
  const legs = "   / \\  ";

  console.log(man);
  console.log(arms);
  console.log(legs);
  base.forEach(line => console.log(line));
}

drawBurjKhalifa();
