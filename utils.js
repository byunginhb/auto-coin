// 숫자 소수점 자릿수 잘라내기
const truncateNumber = (strNum, digits) => {
  let num = Number(strNum);
  let factor = Math.pow(10, digits);
  num = Math.floor(num * factor) / factor;
  return num;
};

exports.utils = {
  truncateNumber,
};
