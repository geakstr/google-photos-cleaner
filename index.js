const path = require("path");
const { statSync, readdirSync } = require("fs");
const { spawnSync } = require("child_process");
const glob = require("glob");
const eachSeries = require("async/eachSeries");
const {
  pathExistsSync,
  ensureDirSync,
  copySync,
  readJsonSync,
  mkdirpSync
} = require("fs-extra");
const moment = require("moment");

const cwd = process.cwd();
const args = process.argv.slice(2);
const scanDir = path.resolve(`${cwd}/${args[0]}`);
const outputDir = path.resolve(`${cwd}/${args[1]}`);
const safeDir = `${outputDir}/safe`;
const unsafeDir = `${outputDir}/unsafe`;
const corruptedDir = `${outputDir}/corrupted`;
const warningsDir = `${outputDir}/warnings`;
const duplicatesDir = `${outputDir}/duplicates`;
const changedExtensionsDir = `${outputDir}/changed-extensions`;

const USAGE = `Usage:

google-photos-cleaner ./dir-to-scan ./output-dir
`;

if (!pathExistsSync(scanDir)) {
  throw new Error(`The directory to scan must exist
  
${USAGE}`);
} else if (!pathExistsSync(outputDir)) {
  ensureDirSync(outputDir);
  ensureDirSync(safeDir);
  ensureDirSync(unsafeDir);
  ensureDirSync(corruptedDir);
  ensureDirSync(warningsDir);
  ensureDirSync(duplicatesDir);
  ensureDirSync(changedExtensionsDir);
} else if (readdirSync(outputDir).length > 0) {
  throw new Error(`Output directory must be empty`);
}

const globOptions = {
  cwd,
  nosort: true,
  nocase: true
};

glob(
  `${scanDir}/**/*.@(jpg|jpeg|png|webp|mov|mpg|mpeg|m2v|wmv|asf|avi|divx|m4v|3gp|3g2|mp4|m2t|m2ts|mts|mkv)`,
  globOptions,
  (error, files) => {
    if (error) {
      throw error;
    }
    const totalFilesCount = files.length;
    let currentFileIndex = 0;

    eachSeries(
      files,
      (file, callback) => {
        const jsonFile = `${file}.json`;

        const stat = statSync(file);
        const fileSize = stat.size;
        const ctime = moment(stat.ctime);
        const mtime = moment(stat.mtime);

        const fileName = path.basename(file);
        const fileExt = path
          .extname(fileName)
          .toLowerCase()
          .slice(1);

        const duplicate = outputPath => {
          console.warn(`Duplicate ${file}`);
          const splited = outputPath.split("/");
          const outputFileName = splited[splited.length - 1];
          const outputBasename = path.basename(outputFileName);
          const dir = `${duplicatesDir}/${outputBasename}`;
          if (!pathExistsSync(dir)) {
            mkdirpSync(dir);
          }
          copySync(file, `${dir}/${currentFileIndex}_${outputFileName}`);
        };

        const copyTo = outputPath => {
          if (pathExistsSync(outputPath)) {
            duplicate(outputPath);
            return false;
          } else {
            copySync(file, outputPath);
            return true;
          }
        };

        const exifDateFormat = "YYYY:MM:DD HH:mm:ss";
        const outputFilenameFormat = "YYYY-MM-DD-HH-mm-ss";

        let validationStatus = "ok";
        let finalExtension = fileExt;
        const rawValidation = spawnSync("exiftool", [
          "-validate",
          "-error",
          "-warning",
          file
        ]).stdout.toString("utf8");

        const validation = rawValidation
          .split("\n")
          .filter(s => s.trim().length > 0)
          .forEach(line => {
            const splited = line.split(":");
            const key = splited[0].trim();
            const value = splited
              .slice(1)
              .join(":")
              .trim();

            if (key === "Validate") {
              if (value === "ok" || value.includes("all minor")) {
                validationStatus = "ok";
              }
            } else if (
              key.toLowerCase().includes("error") ||
              value.toLowerCase().includes("error")
            ) {
              validationStatus = "error";
            } else if (value.startsWith("File has wrong extension")) {
              const regex = /be (\w+), not (\w+)/g;
              value.replace(regex, (match, toExtension) => {
                finalExtension = toExtension.toLowerCase();
              });
              validationStatus = "change extensions";
            } else if (value.startsWith("[minor]")) {
              validationStatus = "ok";
            } else {
              validationStatus = "warning";
            }
          });

        const next = () => {
          if (validationStatus === "error" || validationStatus === "warning") {
            console.warn(rawValidation);
          }
          console.log(
            `${validationStatus} ${++currentFileIndex}/${totalFilesCount} [${fileName}]`
          );
          callback();
        };

        if (validationStatus === "error") {
          copyTo(`${corruptedDir}/${fileName}`);
          next(validationStatus);
          return;
        }

        const exif = spawnSync("exiftool", ["-time:all", "-a", "-s", file])
          .stdout.toString("utf8")
          .split("\n")
          .filter(s => s.trim().length > 0)
          .reduce((map, line) => {
            const splited = line.split(":");
            const key = splited[0].trim();
            const value = splited
              .slice(1)
              .join(":")
              .trim();
            map[key] = value;
            return map;
          }, {});

        let createDate = moment(
          exif.CreateDate ||
            exif.DateTimeOriginal ||
            exif.DateCreated ||
            exif.FileCreateDate,
          exifDateFormat
        );

        if (!createDate.isValid()) {
          if (pathExistsSync(jsonFile)) {
            const { photoTakenTime } = readJsonSync(jsonFile);
            createDate = moment(photoTakenTime.timestamp * 1000);
          }
        }

        const safe = createDate.isValid();

        if (!safe) {
          createDate = ctime.isSameOrBefore(mtime) ? ctime : mtime;
        }

        const outputFileName = `${createDate.format(
          outputFilenameFormat
        )}.${fileSize}.${finalExtension}`;

        const exifCreateDate = createDate.format(exifDateFormat);

        let outputFilePath = "";
        switch (validationStatus) {
          case "ok": {
            outputFilePath = `${safe ? safeDir : unsafeDir}/${outputFileName}`;
            break;
          }
          case "warning": {
            outputFilePath = `${warningsDir}/${outputFileName}`;
            break;
          }
          case "change extensions": {
            outputFilePath = `${changedExtensionsDir}/${outputFileName}`;
            break;
          }
          default: {
            throw new Error(
              `Unsupported validation status = ${validationStatus}`
            );
          }
        }

        if (copyTo(outputFilePath)) {
          spawnSync("exiftool", [
            "-overwrite_original",
            `-CreateDate="${exifCreateDate}"`,
            `-DateTimeOriginal="${exifCreateDate}"`,
            `-DateCreated="${exifCreateDate}"`,
            `-FileCreateDate="${exifCreateDate}"`,
            outputFilePath
          ]).stdout.toString("utf8");
        }

        next();
      },
      error => {
        if (error) {
          console.error(error);
        }
      }
    );
  }
);
