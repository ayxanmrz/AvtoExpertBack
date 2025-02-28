const getManatPrice = (string) => {
  const stringList = string.split(" ");
  const currency = stringList[stringList - 1];
  const value = stringList
    .slice(0, stringList.length - 1)
    .reduce((res, elem) => res + elem);
  console.log(currency);
  console.log(value);
  if (currency === "AZN") {
    return +value;
  } else if (currency === "USD") {
    return value * 1.7;
  } else {
    return null;
  }
};

console.log(getManatPrice("18 000 USD"));