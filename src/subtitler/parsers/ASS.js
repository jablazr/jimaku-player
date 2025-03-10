const SubtitleFormat = require('./SubtitleFormat');

//parser for Advanced SubStation Alpha (.ass) subtitle files
//https://en.wikipedia.org/wiki/SubStation_Alpha#Advanced_SubStation_Alpha

const camelCase = string => {
	return (string.charAt(0).toLowerCase() + string.substring(1)).replace(' ', '');
};

//the legacy alignment numbering system is kind of weird, 1-3 are the same,
//but 5-7 are the top of the screen, then switching to 9-11 for the center.
//but the locations they end up in are all the same, so this just maps
//the legacy alignments to the regular alignment numbers so the renderer
//can treat them both the same way
const legacyAlignmentTranslationMapping = {
	1: 1,
	2: 2,
	3: 3,
	5: 7,
	6: 8,
	7: 9,
	9: 4,
	10: 5,
	11: 6
};

const svgNamespace = 'http://www.w3.org/2000/svg';
function createSVGNSElement(elementName) {
	return document.createElementNS(svgNamespace, elementName);
}
function createSVG() {
	const svg = createSVGNSElement('svg');
	svg.setAttribute('xmlns', svgNamespace);
	return svg;
}

/**
 * Translate a legacy \a override into its matching \an alignment value.
 * @param alignment
 * @returns {*}
 */
const parseLegacyAlignment = alignment => {
	return legacyAlignmentTranslationMapping[alignment];
}

/**
 * Parse an ASS hex color into an rgba color. Also returns a method to weaken the rgba's alpha
 * if it needs to be used in a stacked fashion so it doesn't get overpoweringly opaque trying
 * to imitate a large blur override on a outline.
 * @param assColor
 * @returns {{rgba: string, weakenAlpha: (function(*): string)}}
 */
const parseColor = assColor => {
	if (assColor) {
		assColor = assColor
			// I've seen subtitles that have lower cased colors for some reason. Uppercase them
			// because all the hex regexes look for upper cased letters and it'd otherwise
			// misinterpret every color as black.
			.toUpperCase()
			.replace(/[&H]/g, '')
			// before complex override parsing was more meticulous it was easy for it to stop at the
			// first ) it saw and if it was on a nested complex override it'd stop processing early
			// and lose its closing ). but it's better now so that shouldn't happen, but I have seen
			// an override that had a ) hanging out when it shouldn't, this should trim bad characters
			// in messy overrides that otherwise cause color parsing to fail. need to do this before padding
			.replace(/[^0-9A-F]/g, '')
		assColor = assColor.padStart(8, '0');
		const [_, alpha, blue, green, red] = assColor.match(/([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})/i),
			fromHex = num => parseInt(num, 16);
		//alpha channel numbers are backwards from CSS hex colors, need to invert it
		return {
			rgba: `rgba(${fromHex(red)}, ${fromHex(green)}, ${fromHex(blue)}, ${((255 - fromHex(alpha)) / 255).toFixed(3)})`,
			weakenAlpha: alphaStrength => {
				return `rgba(${fromHex(red)}, ${fromHex(green)}, ${fromHex(blue)}, ${(alphaStrength * ((255 - fromHex(alpha)) / 255)).toFixed(3)})`
			}
		}
	}
};

/**
 * Parse a clip override's instructions into its scale and its drawing commands.
 * @param clipOptions
 * @returns {{scale: *, commands: *[]}}
 */
const parseClip = clipOptions => {
	//clips have two types, rectangle and vector.
	//rectangle clips have four parameters,
	if (clipOptions.length === 4) {
		//todo - rectangle clip
	}
	else {
		//if only drawing commands are given the scale is assumed to be 1
		const [scale, drawingCommands] = clipOptions.length === 1 ? [1, clipOptions[0]] : clipOptions,
			commands = parseDrawingCommands(drawingCommands)

		if (commands) {
			return {
				scale,
				commands
			}
		}
	}
}

/**
 * Parse an ASS drawing command string into an array of objects of the individual
 * path commands and their corresponding float parsed array of coordinates.
 * @param drawText
 * @returns {[]}
 */
const parseDrawingCommands = drawText => {
	if (!drawText) {
		return null;
	}

	const commands = [],
		commandRegex = /([mnlbspc][ \.0-9\-]+)/g;

	for (const commandText of drawText.match(commandRegex)) {
		const [commandName, ...coordinates] = commandText.trim().split(' ');

		//for each drawing command, get the command type (e.g. 'm' - move, 'l' - line, etc),
		//and the sets of coordinates that come with it
		commands.push({
			command: commandName,
			coordinates: coordinates.map(parseFloat)
		});
	}

	//ASS coordinates are weird and allow you to use negative numbers, but that won't show in
	//an SVG path, it'll be out of the boundaries of the SVG, just bump everything up to at least zero
	const makePositiveAmount = -1 * commands.reduce((lowest, {coordinates}) => {
		return Math.min(lowest, ...coordinates)
	}, 0)

	commands.forEach(command => {
		command.coordinates = command.coordinates.map(c => c + makePositiveAmount);
	});
	return commands;
};

/**
 * Translates a series of ASS drawing commands parsed by `parseDrawingCommands` to
 * an SVG path string, along with some measurements about the drawing it contains,
 * which are used to properly size the path when added to an SVG in some way.
 * @param commands
 * @returns {{path: string, viewBox: string, maxHeight: number, maxWidth: number}}
 */
const genPathFromDrawCommands = (commands) => {
	let paths = [];
	let maxWidth = 0, maxHeight = 0;
	//for an accurate viewBox and SVG sizing we need to know how big the SVG is going to be
	function analyzeMaxes(x, y) {
		maxWidth = Math.max(maxWidth, x);
		maxHeight = Math.max(maxHeight, y);
	}

	/**
	 * ASS lets you omit redundant path commands and just give a huge list of coordinates for some
	 * drawing commands, but that doesn't fly with SVGs. So in ASS you can do:
	 * L 100 100 200 200 300 300 which will draw three lines to (100, 100), (200, 200), and (300,300)
	 * but we need to separate that into three commands of two coordinates for SVGs,
	 * this will group the specified commands into groups of commands, so the above
	 * example will be turned into: L 100 100 L 200 200 L 300 300
	 * given a maxCoordsPerCommand of 2. additionally a callback can be
	 * given that will be passed each group of coordinates, so the caller can call
	 * analyzeMaxes, as it'll have a better idea of which coordinates are x and which are y.
	 * @param command - SVG path command code
	 * @param coordinates - an array of coordinates
	 * @param maxCoordsPerCommand - how many coordinates are valid after a command code
	 * @param callbackPerSet - callback to have the caller analyze x/y values for computing maxHeight/maxWidth
	 */
	function pathInSets(command, coordinates, maxCoordsPerCommand, callbackPerSet) {
		const commands = [],
			//copy the coordinates array, otherwise we'll wipe out debug info
			mutableCoordinates = coordinates.slice();
		while (mutableCoordinates.length > 0) {
			const set = mutableCoordinates.splice(0, maxCoordsPerCommand);
			if (callbackPerSet) {
				callbackPerSet(...set);
			}
			commands.push(command + ' ' + set.join(' '));
		}
		paths = paths.concat(commands);
	}

	for (let {command, coordinates} of commands) {
		if (command === 'm' && paths.length > 0) {
			paths.push(' Z '); //'z' closes the path which is what 'm' does in addition to moving
		}

		//if it's an 'n', it's a move command like an 'm', but without closing a path,
		//so now that we're past the path closing condition, treat it as an 'm'
		if (command === 'n') {
			command = 'm';
		}

		if (command === 'l') {
			//ass line commands can take multiple sets of coordinates, but svg paths need
			//to be grouped in sets of two
			pathInSets('L', coordinates, 2, analyzeMaxes);
		}
		else if (command === 'm') {
			paths.push('M' + coordinates.join(' '));
			analyzeMaxes(...coordinates);
		}
		else if (command === 'b') {
			//in an svg path 'C' is a cubic bezier curve, which is 'b' in ASS
			pathInSets('C', coordinates, 6, (x1, y1, x2, y2, x3, y3) => {
				analyzeMaxes(x1, y1);
				analyzeMaxes(x2, y2);
				analyzeMaxes(x3, y3);
			});
		}
	}

	return {
		path: paths.join(' '),
		viewBox: `0 0 ${maxWidth} ${maxHeight}`,
		maxHeight, maxWidth
	};
}

const genOutlineStyles = (outlineColor, outlineWidth, shadowColor='transparent', shadowDepth=0, blur=0) => {
	// many shadows will be stacked, which gives an multiplied shadow color, and the shadow will appear
	// way too thick unless we significantly lower the alpha value on the color. the weakening effect
	// is multiplied by 4 here because there are 4 directions of shadows we stack, and it looks best it seems
	const colorSource = outlineColor || shadowColor,
		color = blur < 1 ? colorSource.rgba : colorSource.weakenAlpha(1 / (4 * outlineWidth));
	blur = `${blur}px`;

	outlineWidth = (typeof outlineWidth === 'undefined' ? 1 : parseInt(outlineWidth, 10));
	let outlines = [];
	//make a ton of stacking shadows, because otherwise thicker outlines won't appear smooth
	for (let i = -1 * outlineWidth; i <= outlineWidth; i++) {
		for (let j = -1 * outlineWidth; j <= outlineWidth; j++) {
			outlines.push(`${i}px ${j}px ${blur} ${color}`);
		}
	}
	if (outlineWidth === 0) {
		outlines = ['none'];
	}
	return `text-shadow: ${outlines.join(', ')}; filter: drop-shadow(${shadowDepth}px ${shadowDepth}px ${blur} ${shadowColor.rgba})`
};

const genFontFamily = fontName => {
	return `font-family: "${fontName}", "Source Han Sans", "源ノ角ゴシック", "Hiragino Sans", "HiraKakuProN-W3", "Hiragino Kaku Gothic ProN W3", "Hiragino Kaku Gothic ProN", "ヒラギノ角ゴ ProN W3", "Noto Sans JP", "Noto Sans CJK JP", "Noto Sans", "メイリオ", Meiryo, "游ゴシック", YuGothic, "ＭＳ Ｐゴシック", "MS PGothic", "ＭＳ ゴシック", "MS Gothic", sans-serif`
};

/**
 * Generator for parsing out blocks of override tags and the text that follows it.
 * This turns:
 * {\fs12}Some small text {\fs24}Some big text
 * Into:
 * yields: {\fs12}Some small text
 * yields: {\fs24}Some big text
 * @param subtitleText
 * @returns {Generator<*, void, ?>}
 */
function* overrideScanner(subtitleText) {
	const nextOverriddenTextReg = /({.*?}[^{]*)/g;
	let next;

	//don't skip text with no overrides at the start
	const firstOverrideIndex = subtitleText.indexOf('{');
	if (firstOverrideIndex > 0) {
		yield {
			text: subtitleText.substring(0, firstOverrideIndex),
			overrides: {}
		};
	}

	while ((next = nextOverriddenTextReg.exec(subtitleText)) !== null) {
		yield parseOverrides(next[1])
	}
}

/**
 * A list of override tags we parse (but not necessarily support),
 * 'tag' is the ASS override tag, we'll map it to a more friendly
 * property name when parsing overrides. 'complex' is a boolean
 * determining if we should expect to see arguments (like,this)
 * instead of just immediately after the override tag name.
 *
 * Multiple overrides can target the same 'friendly' name if they have the same effect.
 *
 * Since the parser is fairly dumb and doesn't know when an override tag ends and the value begins
 * it's recommended that overrides are checked for in order from most specific name to least specific,
 * i.e. look for a 'fscx' before a 'fs' override, if you didn't you might get a value of 'cx' instead of the
 * font size you were expecting to get. If an override is found it's removed from the overrides yet to be
 * processed for this phrase and won't be considered next time checkOverride is called (hence why you can look
 * for 'fscx' then safely look for 'fs', 'fscx' won't be in the overrides anymore). The exception is complex
 * tags, as we know a '(' immediately follows the override tag, so they can be first if needed (if their
 * arguments are likely to contain more overrides like '\t' does, otherwise we'll match a general style
 * instead of a part of an animation)
 *
 * Some tags (repeatable=true) can occur more than once in a list of overrides (\t), we need to capture every instance
 * before trying to parse anything else, or we might get part of what's supposed to be a transition
 * and interpret it as a regular override for the whole duration of the subtitle instead of just part.
 *
 * Some tags (parseTogether=true) might not have the same data type for all arguments (\clip)
 * and using one parser for all values in a list of complex arguments would cause trouble.
 */
const intBase10 = numStr => parseInt(numStr, 10),
	knownOverrides = [
		{ tag: 't', friendly: 'animatedTransform', complex: true, repeatable: true },
		{ tag: 'move', friendly: 'movement', complex: true, parser: parseFloat },
		{ tag: 'clip', friendly: 'clip', complex: true, parser: parseClip, parseTogether: true },
		{ tag: '3c', friendly: 'outlineColor', parser: parseColor },
		{ tag: '4c', friendly: 'shadowColor', parser: parseColor },
		{ tag: 'bord', friendly: 'outlineSize' },
		{ tag: 'shad', friendly: 'shadowDepth' },
		// 'blur' and 'be' overrides should use different blur methods,
		// but it's just going to be the same text shadow anyway,
		// so both will just write to the same 'blur' friendly property
		{ tag: 'blur', friendly: 'blur' },
		{ tag: 'be', friendly: 'blur' },
		{ tag: 'pos', friendly: 'position', complex: true, parser: intBase10 },
		{ tag: 'an', friendly: 'alignment' },
		{ tag: 'org', friendly: 'origin', complex: true },
		{ tag: 'fscx', friendly: 'fontScaleX' },
		{ tag: 'fscy', friendly: 'fontScaleY' },
		{ tag: 'frx', friendly: 'rotateX' },
		{ tag: 'fry', friendly: 'rotateY' },
		{ tag: 'frz', friendly: 'rotateZ' },
		{ tag: 'fad', friendly: 'fade', complex: true, parser: intBase10 },
		{ tag: 'fsp', friendly: 'letterSpacing' },
		{ tag: 'fs', friendly: 'fontSize' },
		{ tag: 'u', friendly: 'underline' },
		{ tag: 's', friendly: 'strikethrough' },
		{ tag: 'b', friendly: 'bold', parser: intBase10 },
		{ tag: 'i', friendly: 'italic', parser: intBase10 },
		{ tag: 'fn', friendly: 'fontName' },
		{ tag: '1c', friendly: 'color', parser: parseColor },
		// 'c' is an abbreviation for '1c' (primary fill color aka text color)
		{ tag: 'c', friendly: 'color', parser: parseColor },
		{ tag: 'r', friendly: 'reset', defaultValue: false},
		{ tag: 'q', friendly: 'wrapStyle' },
		{ tag: 'p', friendly: 'drawMode' },
		{ tag: 'a', friendly: 'alignment', parser: parseLegacyAlignment },
	];

/**
 * Some overrides need their values parsed, like colors and integers, if
 * a parser exists for that override this will run it on every value
 * @param value
 * @param parser
 * @param parseTogether - if the parser should be run on the whole value (true), or each (false, default)
 * @returns {*}
 */
function runOverrideValueParser(value, parser, parseTogether=false) {
	if (!parser) {
		return value;
	}

	if (parseTogether) {
		return parser(value);
	}

	return Array.isArray(value) ? value.map(parser) : parser(value);
}
/**
 * Get an object of all overrides that can be found in the phrase
 * @param overridesAndText - a string yielded from overrideScanner
 */
function parseOverrides(overridesAndText) {
	const rawText = overridesAndText, //kept around for debugging
		text = overridesAndText.replace(/{.*?}/g, ''),
		friendlyOverrides = {}, // a map of friendly names to values we want to program to
		rawOverrides = {}; // a map of the original ASS tag names to their values for debugging

	//normally would want to safety check the match, but we know we have some if this
	//function was called in the first place
	let [overridesString] = overridesAndText.match(/{.*?}/);

	for (const {tag, friendly, complex=false, defaultValue, parser, repeatable=false, parseTogether} of knownOverrides) {
		let result = getOverride(overridesString, tag, complex)

		let i = 0;
			// for overrides which support only a single value, only check once,
			// but for overrides that can repeat (\t) check until something is found
		while ((!repeatable && i === 0) || (repeatable && result)) {
			if (result) {
				overridesString = result.overrides;

				const parsedValue = runOverrideValueParser(result.params, parser, parseTogether) || defaultValue;
				// only parse friendly overrides, the raw ones should stay as-is
				friendlyOverrides[friendly] = !repeatable ? parsedValue :
					//if it's a repeatable value (like \t that can occur more than once),
					//we need to build an array of the times it's been called
					[...(friendlyOverrides[friendly] || []), parsedValue];
				rawOverrides[tag] = !repeatable ? result.params : [...(rawOverrides[tag] || []), result.params];
			}

			result = getOverride(overridesString, tag, complex);
			i++;
		}
	}

	return {
		text,
		rawText,
		overrides: friendlyOverrides,
		rawOverrides
	}
}

/**
 * Try and find an override for a specific override code in a subtitle's override string.
 * @param overrides - an override string from a subtitle, may or may not contain this override
 * @param overrideCode - an override code to search for
 * @param isComplex - is the value complex? this is any override that accepts (arguments,like,this)
 * @returns {{overrides: (void|string|*), params: []}|{overrides: (void|string|*), params: *}}
 */
function getOverride(overrides, overrideCode, isComplex=false) {
	//complex overrides can have complex overrides within them, like a \clip within a \t
	//so we can't just grab everything within the first sets of parenthesis we see, or
	//we might cut off at the end of the nested override, need to be more careful
	if (isComplex) {
		const overrideMatch = overrides.match(`\\\\${overrideCode}\\((.*)`);
		if (!overrideMatch) {
			return;
		}

		let params = [],
			//the full override text, to sanitize the remaining override string at the end
			thisOverride = '',
			//the current parameter we're walking through
			thisParam = '',
			//can you nest a complex in a complex in a complex? probably not, only assuming one level is probably fine
			skippingComplex = false;

		//the text starting at this override's params, until the end of the overrides string,
		//we need to figure out how far to go until we hit the matching parenthesis, taking
		//care not to match a nested complex tag
		const paramsAndMore = overrideMatch[1];
		for(let i = 0; i < paramsAndMore.length && overrides; i++) {
			const thisCharacter = paramsAndMore[i];

			function keep() {
				thisParam += thisCharacter;
				thisOverride += thisCharacter;
			}
			if (thisCharacter === '(') {
				keep(); //this won't fall into the else, need to start the override's parameters
				skippingComplex = true;
			}
			//end of a parameter, or the end of the string, need to store the param regardless, maybe we're done
			else if (!skippingComplex && (thisCharacter === ',' || thisCharacter === ')')) {
				params.push(thisParam);
				thisOverride += thisCharacter;
				thisParam = '';

				if (thisCharacter === ')') {
					return {
						overrides: overrides.replace(`\\${overrideCode}(` + thisOverride, ''),
						params
					};
				}
			}
			else if (skippingComplex && thisCharacter === ')') {
				keep(); //this won't fall into the 'else', need to terminate the override
				skippingComplex = false;
			}
			else {
				keep();
			}
		}
	}
	const overrideReg = new RegExp(`\\\\${overrideCode}([^\\\\}]*)`),
		overrideMatch = overrides.match(overrideReg);

	if (!overrideMatch) {
		return;
	}
	return {
		//pass the overrides back that don't contain this override anymore
		overrides: overrides.replace(overrideMatch[0], ''),
		params: overrideMatch[1]
	};
}

// export default class ASS extends SubtitleFormat {
class ASS extends SubtitleFormat {
	/**
	 * @param ass - .ass file contents
	 * @param fileName
	 */
	constructor(ass, fileName) {
		super('ass', fileName);
		const start = Date.now();

		//much easier to parse without carriage returns, keep in mind though that \\r is a 'reset' override tag
		ass = ass.replace(/\r\n/g, '\n');
		try {
			this.blocks = this.parseBlocks(ass);
			this.subs = this.parseBlock(this.blocks.subs);
			this.parseInfo(this.blocks.info);
			this.parseSubTimings();
			this.parseStyles(this.parseBlock(this.blocks.styles));
			this.parseSubOverrideTags();
		} catch(e) {
			console.error('[Jimaku Player] ASS parse error', e);
			if (this.parsingSub) {
				console.error('[Jimaku Player] Error occurred parsing this line', this.parsingSub)
			}
			// if we errored out, having no subs is an error condition detected elsewhere
			this.subs = [];
		}

		this.parseTime = Date.now() - start;
	}

	serialize(atTime) {
		let subs = this.subs,
			styles = this.styles;

		if (typeof atTime === 'number') {
			subs = this.getSubs(atTime);
			styles = {};
			//filter styles down to only what is used by the current subtitles
			for (const {style} of subs) {
				styles[style] = this.styles[style];
			}
		}
		return JSON.stringify({
			info: this.info,
			styles,
			subs,
		}, null, 4);
	}

	debugInfo() {
		return [{
			title: 'Number of styles',
			detail: Object.keys(this.styles).length
		}, {
			title: 'Number of subtitles',
			detail: this.subs.length
		}];
	}

	/**
	 * Parse the script metadata block, mostly just care about the PlayResX/PlayResY
	 * values from this, which give insight to how big 1px is supposed to be relative
	 * to the target video's resolution. (see 'scaleHeight' and 'scaleWidth').
	 */
	parseInfo() {
		this.info = {};
		this.blocks.info
			.split('\n')
			.forEach(line => {
				const [key, value] = line.split(/: ?/);
				this.info[camelCase(key)] = value;
			})

		//some subtitle scripts have been seen to not include playResX/playResY in
		//the info block, resulting in NaNvh heights for font sizes which makes them
		//really tiny and impossible to fix with the font size scaling setting (NaN * 3 = NaN).
		//this works around that case by giving a default player size, if the subtitles
		//end up being too big or small the user can fix it with the scaling setting.
		if (!this.info.playResX) {
			this.info.playResX = 1280;
		}
		if (!this.info.playResY) {
			this.info.playResY = 720;
		}
	}

	/**
	 * Scale an Y coordinate (height or size) to viewport height based units depending
	 * relative to the ASS script's target resolution.
	 *
	 * In an ASS script, sizes and positions are in pixels but those are relative to the
	 * script resolution (the PlayResX/PlayResY values in the script info block). But if
	 * those pixel values are treated at face value they will only be accurate if the video
	 * size exactly matches those resolutions. To fix this we have to convert every size
	 * into automatically scaling vh/vw units so no runtime scaling needs to be done.
	 * If a video has a 1280x720 script resolution, a 50px value in a height
	 * is 50/720th of the height of the video, in vh units that's 6.94vh and using that
	 * will give whatever it's used for the same size or position relative to the video
	 * no matter what the size of the video player is.
	 * @param height - a value in the Y axis (height or position Y) from an ASS script
	 * @param noUnit - return without units, used when math needs to be done at run-time
	 * @returns {number|string}
	 */
	scaleHeight(height, noUnit=false) {
		const scaledHeight = 100 * (height / +this.info.playResY);
		return noUnit ? scaledHeight : `${scaledHeight}vh`;
	}

	/**
	 * Scale an X coordinate, same reasoning as 'scaleHeight'
	 * @param width
	 * @returns {number|string}
	 */
	scaleWidth(width) {
		const scaledWidth = 100 * (width / +this.info.playResX)
		return `${scaledWidth}vw`;
	}

	/**
	 * ASS subtitles have data in INI-like sections, under a header like [Events],
	 * this takes an ASS subtitle script and splits it into the important blocks
	 * to be later parsed individually.
	 * @param ass - the raw text contents of an .ass subtitle file
	 */
	parseBlocks(ass) {
		//split the ass file by newlines followed by a [, we know those are the start of the headings
		const splitByBlocks = ass.split(/\n(?=\[)/),
			captureBlock = (heading) => {
				const block = splitByBlocks.find(block => {
					//be tolerant of errant spacing, have seen blocks start like " [Script Info]"
					block = block.trim();
					//parse out the text inside the header
					const [_, blockHeading] = block.match(/^\[(.*?)]/);
					return blockHeading === heading;
				});
				//strip out the heading, it'll be the only thing on the first line
				return block
					.replace(/.*\n/, '').trim();
			};

		return {
			info: captureBlock('Script Info'),
			styles: captureBlock('V4+ Styles'),
			subs: captureBlock('Events')
		};
	}

	/**
	 * The [V4+ Style] and [Events] blocks come with data in a CSV-like format, this
	 * will create objects that match up the 'column headers' present in the "Format" line
	 * with the data in each line that follows it.
	 *
	 * The subtitles will look roughly like this:
	 * Format: Layer, Start, End, Text
	 * Dialogue: 0,0:00:02.43,0:00:03.54,了解しました
	 * Dialogue:...
	 *
	 * This function will transform that to something like:
	 * [{
	 *     dataType: 'dialogue',
	 *     layer: "0",
	 *     start: "0:00:02.43",
	 *     end: "0:00:03.54",
	 *     text: "了解しうました"
	 * }, ...]
	 */
	parseBlock(block) {
		//the first line is a 'Format' line, which specifies the data that each comma separated value on the following lines represent
		const [formatLine, ...subs] = block.split('\n');

		const parseLine = (line, attrMax=Infinity) => {
			// each line will be something like "Dialogue: 2,3,5" etc, keep The first bit tells us what kind of line it is
			// and the rest are comma separated attributes. The first line is the format line, which specifies the names
			// of each comma separated attribute that's on each following line
			let [_, lineType, attributes] = line.match(/(\w*): (.*)/);

			attributes = attributes.split(',');
			//if the last attribute has commas in it, we'll exceed the number of attributes the Format
			//line specifies, so we need to re-assemble anything that exceeds that limit into the last
			//attribute's place. this can also happen as the result of override tags.
			//
			// ex:
			//Format: Start, End, Text
			//Dialogue: 0,1,{\pos(424,12)}Hello, World!
			//just splitting on commas would give us the attributes:
			//["0", "1", "{\pos(424", "12)}Hello", " World!"]
			//but it should be
			//["0", "1", "{\pos(424,12)}Hello World!"]
			if (attributes.length > attrMax) {
				attributes[attrMax - 1] = attributes.slice(attrMax - 1).join(',');
				attributes.splice(attrMax, Infinity);
			}

			return {
				type: lineType,
				attributes: attributes
			}
		};
		const format = parseLine(formatLine);

		return subs.reduce((done, line) => {
			//skip blank lines and comments
			if (!line || line.charAt(0) === ';' || line.indexOf('Comment: ') === 0) {
				return done;
			}
			const lineData = parseLine(line, format.attributes.length);
			//zip the attributes with the format names
			const zipped = {
				dataType: lineData.type.toLowerCase()
			};

			format.attributes.forEach((columnHeader, index) => {
				columnHeader = columnHeader.trim();
				//camel case
				const propName = camelCase(columnHeader);
				zipped[propName] = lineData.attributes[index];
			});

			// sometimes *Default === Default, just make anything here and in styles that use either just be "Default"
			zipped.style = zipped.style === '*Default' ? 'Default' : zipped.style;
			zipped._id = this.genId();
			done.push(zipped);

			return done;
		}, [])
	}
	parseSubTimings() {
		this.subs.forEach(sub => {
			//keep original timings around for debugging
			sub.rawStart = sub.start;
			sub.rawEnd = sub.end;
			sub.start = this.timeToMs(sub.start);
			sub.end = this.timeToMs(sub.end);
		})
	}

	parseStyles(styles) {
		const parsedStyles = {};
		styles.forEach(style => {
			/**
			 * Colors and stuff are weird in the ASS spec, they're in a backwards order (AABBGGRR) to rgba
			 */

			for (const colorKey of Object.keys(style).filter(k => /colour/i.test(k))) {
				style[colorKey] = parseColor(style[colorKey]);
			}

			// sometimes *Default === Default, just make anything here and in subs that use either just be "Default"
			style.name = style.name === '*Default' ? 'Default' : style.name;

			//figure out all the inline styles that will be needed to render the sub, do it once now so
			//Subtitles.svelte doesn't end up doing this on every frame
			const inlineStyle = [],
				//for boolean values within the style declarations ASS considers -1 to be true and 0 to be false,
				//note this is different in overrides
				assTrue = '-1',
				{
					primaryColour, secondaryColour, outlineColour, backColour, borderStyle, outline,
					shadow, fontname, fontsize, bold, italic, underline, strikeOut, alignment,
					marginL, marginR, marginV
				} = style;

			//these styles might always be defined, so maybe we don't need to safety check any of these
			if (primaryColour) {
				inlineStyle.push(`color: ${primaryColour.rgba}`);
			}
			if (fontname) {
				inlineStyle.push(genFontFamily(fontname));
			}

			if (borderStyle === '1') { //outline + drop shadow
				inlineStyle.push(genOutlineStyles(outlineColour, outline, backColour, shadow));
			}
			else if (borderStyle === '3') { //opaque box
				inlineStyle.push(`background-color: ${backColour.rgba}`);
			}

			if (bold === assTrue) {
				inlineStyle.push(`font-weight: bold`);
			}
			if (italic === assTrue) {
				inlineStyle.push(`font-style: italic`);
			}
			if (underline === assTrue || strikeOut === assTrue) {
				inlineStyle.push(`text-decoration: ${underline === assTrue ? 'underline': ''} ${strikeOut === assTrue ? 'line-through' : ''}`);
			}

			parsedStyles[style.name] = {
				inline: inlineStyle.join(';'),
				marginL: this.scaleWidth(marginL),
				marginR: this.scaleWidth(marginR),
				marginV: this.scaleHeight(marginV),
				fontSize: this.genScaledFont(fontsize),
				//keep parsed styles as-is for debugging
				raw: style
			};
		});

		this.styles = parsedStyles;
	}

	genScaledFont(fontSize) {
		//no exact science to the 0.7 here. it just seemed to be closer to the way
		//the same subtitles looked in VLC. There could be something more to this
		return this.scaleHeight(fontSize * 0.7, true);
	}

	parseSubOverrideTags() {
		/**
		 * Subtitles can have "overrides" which are like the inline-style of .ass subtitles. They apply to that
		 * single line of subtitles, and are cumulative for the line unless they're reset or overridden by another
		 * value of the same type of override tag.
		 *
		 * Because these overrides apply to subsections of the subtitle the parsing and styling is done in two stages,
		 * first the overall subtitle (a "Dialogue" line in the ASS file) called "sub" here, and each chunk of text and
		 * its styling between override tags within the sub called "phrases" here.
		 *
		 * Assume we've got the following subtitles:
		 * {\b1}いいよ。{\i1}というかなんで
		 * They should be parsed like:
		 * [{inline: 'font-weight: bold', text: 'いいよ。'}, {inline: 'font-weight: bold; font-style: italic', text: 'というかなんで'}]
		 * Because the styles are cumulative. If a later style overwrites it with something else, the browser will handle displaying
		 * only the second one. So all styles need to be able to add or remove styles
		 */
		this.subs.forEach(sub => {
		    //copy the subtitle we're parsing overrides for, this lets us log the line that caused parsing to fail
			this.parsingSub = JSON.parse(JSON.stringify(sub));

			//keep the unchanged text around for debugging purposes
			sub.rawText = sub.text;

			sub.text = sub.text
				//\n is a soft line break where the subtitle renderer can choose if it needs a line break here,
				//essentially a <wbr> but it's easier to ignore that for now and treat it as a space
				.replace(/\\n/g, ' ')
				//these characters need to be double escaped
				.replace(/\\N/g, '\n') //hard new line
				//non "hard spaces" on the ends of the text are supposed to be ignored
				.trim()
				//subtitles are rendered with `white-space:pre` so just using a space character for a hard space should be enough
				.replace(/\\h/g, ' '); //hard space

			const inheritedStyle = this.styles[sub.style];
			sub.mountPoint = inheritedStyle.raw.alignment;

			//just ignore lines with no overrides
			if (!/{.+?}/.test(sub.text)) {
				return;
			}

			sub.phrases = [];

			const removeOverrideText = text => text.replace(/{.*?}/g, '');

			//create a scanner for overrides and the text that immediately follows them
			const scanner = overrideScanner(sub.text);
			//with each override block (unless we hit a reset, \r), we're going to be building upon whatever overrides
			//we've parsed so far.
			let cumulativeStyles = [];
			//go block by block of overridden text
			for (const scanned of scanner) {
				const containerInline = [],
					phrase = {
						_id: this.genId(),
						text: scanned.text,
						fadeIn: 0,
						fadeOut: 0,
						inline: '',
						overrides: scanned.overrides,
						rawOverrides: scanned.rawOverrides,
						rawText: scanned.rawText,
						//generated SVG structure for drawings and clip paths
						html: ''
					},
					{overrides} = scanned;

				//todo - parse more tags
				//http://docs.aegisub.org/3.2/ASS_Tags/

				//outline and shadow use a bunch of text-shadows, so they need to all be parsed at once, and their result computed
				//if any of them are defined, merge them in with the applied style's definitions, then generate an outline/shadow style
				if (overrides.outlineColor || overrides.shadowColor || overrides.outlineSize || overrides.shadowDepth || overrides.blur ) {
					const baseStyle = this.styles[sub.style];

					// just in case there's no style applied? unsure if that's possible, but checking just in case
					if (baseStyle) {
						//styles on the base style are using the 'ou' spelling of color etc
						const outlineColor = overrides.outlineColor || baseStyle.raw.outlineColour,
							shadowColor = overrides.shadowColor || baseStyle.raw.backColour,
							outlineSize = overrides.outlineSize || baseStyle.raw.outline,
							shadowDepth = overrides.shadowDepth || baseStyle.raw.shadow;

						//not using a blur fallback, because blur is only ever defined in an override it seems
						cumulativeStyles.push(genOutlineStyles(outlineColor, outlineSize, shadowColor, shadowDepth, overrides.blur));
					}
				}

				let transforms = [];
				if (overrides.position || overrides.movement) {
					sub.mountPoint = 'positioned';

					if (overrides.position) {
						const [x, y] = overrides.position;
						//positioning applies to the line, and if we just put it on this span it might get put in the right space, but the
						//containing paragraph elements will stack, possibly overlapping the video controls if
						containerInline.push(`position: fixed; left: ${this.scaleWidth(x)}; top: ${this.scaleHeight(y)}`);
					}
					else if (overrides.movement) {
						const [x1, y1, x2, y2, ...timings] = overrides.movement;
						sub.movement = {
							x1: this.scaleWidth(x1),
							y1: this.scaleHeight(y1),
							x2: this.scaleWidth(x2),
							y2: this.scaleHeight(y2),
							//setting both times to zero in ASS movement is equivalent to not having timings at all
							timings: timings.every(t => t === 0) ? [] : timings
						}
					}

					//if the text is explicitly positioned we don't want any unwanted wrapping, it's probably something
					//pretty short that's probably exactly where it needs to be, letting it wrap when it shouldn't might not be good
					containerInline.push('white-space: pre');

					//CSS positioning moves as if it's \an7 (i.e. positioning sets the top left corner's position)
					//but by .ass positionings seem to work like \an5, (i.e. positioning sets the center's position)
					//so we need to first reconcile the difference in movement by adding
					//an extra -50%, -50%, so that's why these numbers look weird, without
					//that adjustment all positioned subtitles are too far down and right
					const origin = {
						'1': '0, -100%',
						'2': '-50%, -100%',
						'3': '-100%, -100%',
						'4': '0, -50%',
						'5': '-50%, -50%',
						'6': '-100%, -50%',
						'7': '0, 0',
						'8': '-50%, 0',
						'9': '-100%, 0'
					}[overrides.alignment || inheritedStyle.raw.alignment];
					containerInline.push(`transform: translate(${origin})`);

					if (overrides.origin) {
						const [orgX, orgY] = overrides.origin;
						cumulativeStyles.push(`transform-origin: ${this.scaleWidth(orgX)} ${this.scaleHeight(orgY)}`);
					}
				}
				else if (overrides.alignment) {
					sub.mountPoint = overrides.alignment
				}

				const {fontScaleX, fontScaleY} = overrides;
				if (fontScaleX) {
					transforms.push(`scaleX(${fontScaleX}%)`);
				}
				if (fontScaleY) {
					transforms.push(`scaleY(${fontScaleY}%)`);
				}

				const rotations = [];
				const checkRotate = (deg, rotationTransform, multiplier=1) => {
					if (deg !== undefined) {
						deg = parseFloat(deg) * multiplier;
						return rotations.push(`${rotationTransform}(${deg}deg)`);
					}
				};

				checkRotate(overrides.rotateY, `rotateY`);
				checkRotate(overrides.rotateX, `rotateX`);
				//the direction of rotation seems to be different for the y/z axis compared to css transforms
				checkRotate(overrides.rotateZ, `rotateZ`, -1);

				if (rotations.length) {
					transforms.push(`perspective(200px)`);
					transforms.push(rotations.join(' '));
				}

				if (transforms.length) {
					//without if text is inline it won't rotate or scale, using position: absolute also
					//seems to allow the transforms to work, but then the positioning gets messed up
					cumulativeStyles.push(`display: inline-block`);
					cumulativeStyles.push(`transform: ${transforms.join(' ')}`);
				}

				if (overrides.fade) {
					phrase.fadeIn = overrides.fade[0];
					phrase.fadeOut = overrides.fade[1];

					//svelte will not start animating until the sub is done showing and not before,
					//so we need to subtract the amount of fadeout time from the subtitle's end time so it works
					sub.end -= phrase.fadeOut;
				}

				if (overrides.letterSpacing) {
					cumulativeStyles.push(`letter-spacing: ${overrides.letterSpacing}px`);
				}

				if (overrides.fontSize) {
					phrase.fontSize = this.genScaledFont(overrides.fontSize);
				}

				//need to handle underline and strike through decorations at the same time, because it's the same css property
				//TODO these need to not disable inherited underline/strikethrough, if neither exist we just set to `none` now
				const textDecorationOptions = [];
				if (overrides.underline) {
					textDecorationOptions.push('underline');
				}
				if (overrides.strikethrough) {
					textDecorationOptions.push('line-through');
				}
				if (textDecorationOptions.length) {
					cumulativeStyles.push(`text-decoration: ${textDecorationOptions.length ? textDecorationOptions.join(' ') : 'none'}`);
				}

				const {bold, italic} = overrides;
				if (bold !== undefined) {
					const boldSettings = {
						[bold]: bold,
						1: 'bold',
						0: 'normal',
					};
					cumulativeStyles.push(`font-weight: ${boldSettings[bold]}`);
				}

				if (typeof italic === 'number') {
					cumulativeStyles.push(`font-style: ${!!italic ? 'italic' : 'normal'}`);
				}

				if (overrides.fontName) {
					cumulativeStyles.push(genFontFamily(overrides.fontName));
				}

				//colors
				if (overrides.color) {
					cumulativeStyles.push(`color: ${overrides.color.rgba}`)
				}

				if (overrides.reset) {
					const srcStyle = this.styles[overrides.reset];
					cumulativeStyles = [srcStyle.inline];
				}
				//if we're not switching to another style, just blank out the styles
				else if (overrides.reset === false) {
					cumulativeStyles = [];
				}

				if (overrides.drawMode === '1') {
					const drawing = this.draw(phrase.text, overrides, inheritedStyle)
					phrase.html += drawing.html;
					phrase.drawCommands = drawing.commands;
					phrase.text = '';
					//SVGs don't have anything you can define, and searching jisho for a path is just going to be nonsense
					containerInline.push('pointer-events: none');

					if (overrides.blur) {
						cumulativeStyles.push(`filter: blur(${overrides.blur}px)`);
					}
				}

				if (overrides.clip) {
					const {html, clipId} = this.clip(overrides.clip, phrase._id);
					cumulativeStyles.push(`clip-path: url(#${clipId})`)
					phrase.html += html;
				}

				phrase.inline = cumulativeStyles.join(';');
				sub.phrases.push(phrase);
				if (containerInline.length) {
					sub.inline = containerInline.join(';');
				}
			}

			//now that we've finished parsing all overrides, we should remove overrides from the plain text, otherwise they'll
			//have to be handled wherever we're not showing styled text (alignment button and jisho searches)
			sub.text = removeOverrideText(sub.text);
		});

		this.parsingSub = null;
	}

	genSvg(commands, scale=1) {
		const svgElement = createSVG(),
			pathElement = createSVGNSElement('path');

		const {
			path,
			maxHeight,
			maxWidth,
			viewBox
		} = genPathFromDrawCommands(commands);

		svgElement.setAttribute('viewBox', viewBox);
		pathElement.setAttribute('d', path);
		svgElement.setAttribute('width', this.scaleWidth(maxWidth))
		svgElement.setAttribute('height', this.scaleHeight(maxHeight))

		//not actually appending the two together, as both usages of these have different
		//structure depending on drawing vs clip shape
		return {
			svg: svgElement,
			path: pathElement
		}
	}

	clip({scale, commands}, phraseId) {
		const {svg, path} = this.genSvg(commands, scale),
			defs = createSVGNSElement('defs'),
			clipPath = createSVGNSElement('clipPath'),
			clipId = `clip-path-${phraseId}`;

		clipPath.setAttribute('id', clipId);

		svg.appendChild(defs);
		defs.appendChild(clipPath);
		clipPath.appendChild(path);

		return {
			html: svg.outerHTML,
			clipId,
			commands
		}
	}

	draw(drawText, overrides, inheritedStyle) {
		const commands = parseDrawingCommands(drawText),
			{svg, path} = this.genSvg(commands);

		function overrideOrInherit(overrideColor, inheritedColor) {
			return overrideColor ? overrideColor.rgba : inheritedColor.rgba;
		}

		path.setAttribute('fill', overrideOrInherit(overrides.color, inheritedStyle.raw.primaryColour));
		svg.appendChild(path);

		return {
			html: svg.outerHTML,
			commands
		};
	}
}

module.exports = {
	getOverride,
	parseColor,
	ASS
}
