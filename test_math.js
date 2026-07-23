function testClosePartial(totalVolume, percentToClose) {
    let step = 1;
    while (totalVolume % (step * 10) === 0 && step < 100000) step *= 10;
    
    const volumeToClose = Math.floor((totalVolume * (percentToClose / 100)) / step) * step;
    return { step, volumeToClose, remaining: totalVolume - volumeToClose };
}

console.log("For 4,100,000:", testClosePartial(4100000, 50));
console.log("For 41,000,000:", testClosePartial(41000000, 50));
