import React from "react";

export function List() {
  const isLess = 1 < 2;
  const re = /x\/\/y/;
  return (
    <ul className={styles.list}>
      <li>{items.map((item) => item.name)}</li>
      <br />
    </ul>
  );
}
