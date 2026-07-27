import {
    ISeriesPrimitive,
    IPrimitivePaneView,
    IPrimitivePaneRenderer,
    SeriesAttachedParameter,
    Time,
} from 'lightweight-charts';

interface BoxOptions {
    time1: Time;
    price1: number;
    time2: Time;
    price2: number;
    color: string;
}

class BoxRenderer implements IPrimitivePaneRenderer {
    _options: BoxOptions;
    _x1: number | null = null;
    _x2: number | null = null;
    _y1: number | null = null;
    _y2: number | null = null;

    constructor(options: BoxOptions) {
        this._options = options;
    }

    updatePositions(x1: number | null, x2: number | null, y1: number | null, y2: number | null) {
        this._x1 = x1;
        this._x2 = x2;
        this._y1 = y1;
        this._y2 = y2;
    }

    draw(target: any) {
        if (this._x1 === null || this._x2 === null || this._y1 === null || this._y2 === null) return;
        
        target.useBitmapCoordinateSpace((scope: any) => {
            const ctx = scope.context;
            
            const x1 = Math.round(this._x1! * scope.horizontalPixelRatio);
            const x2 = Math.round(this._x2! * scope.horizontalPixelRatio);
            const y1 = Math.round(this._y1! * scope.verticalPixelRatio);
            const y2 = Math.round(this._y2! * scope.verticalPixelRatio);

            const width = Math.max(1, x2 - x1);
            const height = Math.abs(y2 - y1);
            const topY = Math.min(y1, y2);

            ctx.fillStyle = this._options.color;
            ctx.fillRect(x1, topY, width, height);
        });
    }
}

class BoxView implements IPrimitivePaneView {
    _source: BoxPrimitive;
    _renderer: BoxRenderer;

    constructor(source: BoxPrimitive) {
        this._source = source;
        this._renderer = new BoxRenderer(source._options);
    }

    update() {
        const series = this._source._series;
        const timeScale = this._source._chart.timeScale();
        if (!series || !timeScale) return;

        let x1: number | null = null;
        let x2: number | null = null;
        let y1: number | null = null;
        let y2: number | null = null;

        try {
            x1 = timeScale.timeToCoordinate(this._source._options.time1);
        } catch (e) {
            // Si time1 no existe (muy viejo o fuera de escala), intentamos dibujarlo desde el borde izquierdo
            x1 = 0;
        }

        try {
            x2 = timeScale.timeToCoordinate(this._source._options.time2);
        } catch (e) {
            // Si time2 no existe (en el futuro), lo dibujamos muy a la derecha (fuera de la pantalla)
            x2 = 10000;
        }

        y1 = series.priceToCoordinate(this._source._options.price1);
        y2 = series.priceToCoordinate(this._source._options.price2);

        this._renderer.updatePositions(x1, x2, y1, y2);
    }

    renderer() {
        return this._renderer;
    }
}

export class BoxPrimitive implements ISeriesPrimitive {
    _options: BoxOptions;
    _series: any = null;
    _chart: any = null;
    _paneViews: BoxView[];

    constructor(options: BoxOptions) {
        this._options = options;
        this._paneViews = [new BoxView(this)];
    }

    attached(param: SeriesAttachedParameter<Time>) {
        this._series = param.series;
        this._chart = param.chart;
        this.requestUpdate();
    }

    detached() {
        this._series = null;
        this._chart = null;
    }

    updateAllViews() {
        this._paneViews.forEach(pw => pw.update());
    }

    paneViews() {
        return this._paneViews;
    }

    updateBox(time2: Time) {
        this._options.time2 = time2;
        this.requestUpdate();
    }

    requestUpdate() {
        if (this._series) {
            this._series.applyOptions({}); // Triggers update
        }
    }
}
