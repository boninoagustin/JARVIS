import re

with open('jarvis-os/src/services/backtestEngine.ts', 'r', encoding='utf-8') as f:
    content = f.read()

target = """        if (totalPoints >= minPtsRequired) {
          const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
          oppositeScore.points = 0; oppositeScore.events = [];
        }
        state.lastSniperAlert = nowMs;
        activeScore.points = 0; activeScore.events = [];
      }
    }
  }"""

replacement = """        // El reset solo ocurre SI el trade se dispara (o si se marca la pata para OTE, según live)
      }
    }
  }"""

content = content.replace(target, replacement)

target_takechoch = """        if (takeChoch) {
            const readableTf = parseTF(eventTf);
            const oteData = {
              tradeId, direction: currentDirection,
              entryPrice: currentPrice,
              stopLoss, tp1, tp2, points: totalPoints, events: [...activeScore.events, `${prefix}_${readableTf}`],
              tf: readableTf
            };
            createTrade(oteData, nowMs, trades, activeTrades, dailyStats, config, state);
        }

        if (disableOte) activeLeg.oteScored = true;"""

replacement_takechoch = """        if (takeChoch) {
            const readableTf = parseTF(eventTf);
            const oteData = {
              tradeId, direction: currentDirection,
              entryPrice: currentPrice,
              stopLoss, tp1, tp2, points: totalPoints, events: [...activeScore.events, `${prefix}_${readableTf}`],
              tf: readableTf
            };
            createTrade(oteData, nowMs, trades, activeTrades, dailyStats, config, state);
            
            // ✅ Cooldown y reset SOLO cuando el trade realmente se dispara (idéntico a live)
            state.lastSniperAlert = nowMs;
            activeScore.points = 0; activeScore.events = [];
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            oppositeScore.points = 0; oppositeScore.events = [];
        } else if (!disableOte) {
            // Si va a esperar OTE, reseteamos score y ponemos cooldown, pero dejamos la pata habilitada
            state.lastSniperAlert = nowMs;
            activeScore.points = 0; activeScore.events = [];
            const oppositeScore = currentDirection === 'BUY' ? state.scoreSell : state.scoreBuy;
            oppositeScore.points = 0; oppositeScore.events = [];
        }

        if (disableOte) activeLeg.oteScored = true;"""

content = content.replace(target_takechoch, replacement_takechoch)

with open('jarvis-os/src/services/backtestEngine.ts', 'w', encoding='utf-8') as f:
    f.write(content)
